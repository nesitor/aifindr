import { beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';
import { hashToken } from '../../src/domain/refs.js';
import { createOAuthProvider, MCP_SCOPE } from '../../src/oauth/provider.js';

let repos: Repositories;
let clock: number;

function provider() {
  return createOAuthProvider({ repos, publicBaseUrl: 'https://gateway.test', now: () => clock });
}

async function registerClient(
  p: ReturnType<typeof provider>, redirectUris: string[],
  extra: Partial<Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at' | 'redirect_uris'>> = {},
): Promise<OAuthClientInformationFull> {
  const store = p.clientsStore;
  if (!store.registerClient) throw new Error('registerClient no implementado: el registro dinámico es obligatorio.');
  return store.registerClient({ redirect_uris: redirectUris, ...extra });
}

/** Inserta directamente un código de autorización, saltándose la pantalla de consentimiento
 * (que se prueba por separado en tests/oauth/flow.test.ts). */
function issueCode(
  client: OAuthClientInformationFull, customerId: string,
  overrides: Partial<{ codeChallenge: string; redirectUri: string; expiresAt: number }> = {},
): string {
  const code = `acode_test_${Math.random().toString(16).slice(2)}`;
  repos.oauth.codes.save({
    code, clientId: client.client_id, customerId,
    redirectUri: overrides.redirectUri ?? client.redirect_uris[0],
    codeChallenge: overrides.codeChallenge ?? 'fixed-test-challenge',
    codeChallengeMethod: 'S256', scopes: [MCP_SCOPE],
    expiresAt: overrides.expiresAt ?? clock + 300_000, used: false,
  });
  return code;
}

/** Doble mínimo de `express.Response` para probar `authorize()` directamente: sólo necesita
 * `redirect`, y registra las llamadas para poder inspeccionarlas. */
function fakeRes() {
  const redirects: Array<{ status: number; url: string }> = [];
  const res = { redirect: (status: number, url: string) => { redirects.push({ status, url }); } };
  return { res: res as unknown as Response, redirects };
}

beforeEach(() => {
  const db = openDatabase(':memory:');
  repos = createRepositories(db);
  seedDatabase(repos, db);
  clock = 1_700_000_000_000;
});

describe('clientsStore', () => {
  it('registerClient persiste el cliente y getClient lo recupera por su client_id', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    expect(client.client_id).toBeTruthy();
    expect(client.redirect_uris).toEqual(['https://app.example/callback']);

    const fetched = await p.clientsStore.getClient(client.client_id);
    expect(fetched?.client_id).toBe(client.client_id);
    expect(fetched?.redirect_uris).toEqual(['https://app.example/callback']);
  });

  it('getClient devuelve undefined para un client_id que no existe', async () => {
    const p = provider();
    expect(await p.clientsStore.getClient('client_no_existe')).toBeUndefined();
  });

  it('un cliente público (token_endpoint_auth_method: none) se registra sin client_secret, y registerClient no lo devuelve', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback'], { token_endpoint_auth_method: 'none' });

    expect(client.client_secret).toBeUndefined();
    expect('client_secret' in client).toBe(false); // eliminado explícitamente, no sólo undefined
    expect('client_secret_expires_at' in client).toBe(false);

    const fetched = await p.clientsStore.getClient(client.client_id);
    expect(fetched?.client_secret).toBeUndefined();
  });

  it('un cliente confidencial recibe su client_secret en el registro, y getClient lo devuelve igual (recuperable) para que authenticateClient pueda verificarlo', async () => {
    const p = provider();
    // Simula lo que hace el router del SDK cuando el registro no pide un cliente público: genera
    // un secreto aleatorio y se lo pasa a registerClient ya puesto en el objeto.
    const secretoGeneradoPorElSdk = 'secreto-simulado-de-32-bytes-en-hex';
    const client = await registerClient(p, ['https://app.example/callback'], { client_secret: secretoGeneradoPorElSdk });

    expect(client.client_secret).toBe(secretoGeneradoPorElSdk);

    const fetched = await p.clientsStore.getClient(client.client_id);
    expect(fetched?.client_secret).toBe(secretoGeneradoPorElSdk);
  });

  it('fix round 2 (I3): client_secret_expires_at se persiste y getClient lo devuelve, para que authenticateClient pueda comprobar la caducidad', async () => {
    const p = provider();
    const expiresAtSeconds = Math.floor(clock / 1000) + 30 * 24 * 60 * 60; // como haría el router del SDK: +30 días, en segundos
    const client = await registerClient(p, ['https://app.example/callback'], {
      client_secret: 'secreto-de-prueba', client_secret_expires_at: expiresAtSeconds,
    });
    expect(client.client_secret_expires_at).toBe(expiresAtSeconds);

    const fetched = await p.clientsStore.getClient(client.client_id);
    expect(fetched?.client_secret_expires_at).toBe(expiresAtSeconds);
  });

  it('un cliente público nunca guarda client_secret_expires_at', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback'], { token_endpoint_auth_method: 'none' });
    expect('client_secret_expires_at' in client).toBe(false);
    const fetched = await p.clientsStore.getClient(client.client_id);
    expect(fetched?.client_secret_expires_at).toBeUndefined();
  });
});

describe('authorize() — fix round 2 (CRITICAL): la petición vive en el servidor', () => {
  it('crea una petición pendiente de un solo uso y redirige a /oauth/consent con sólo un request_id opaco', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const { res, redirects } = fakeRes();

    await p.authorize(client, {
      redirectUri: 'https://app.example/callback', codeChallenge: 'reto-del-atacante-o-no',
      scopes: [MCP_SCOPE], state: 'estado-1',
    }, res);

    expect(redirects).toHaveLength(1);
    const url = new URL(redirects[0].url);
    expect(url.pathname).toBe('/oauth/consent');
    const requestId = url.searchParams.get('request_id');
    expect(requestId).toBeTruthy();
    // Crítico: NADA del resto de parámetros viaja en la URL — ni client_id, ni redirect_uri, ni
    // code_challenge, ni scope, ni state. Si viajaran, quien controla el navegador podría fabricar
    // su propia petición sin pasar por aquí.
    expect(url.searchParams.get('client_id')).toBeNull();
    expect(url.searchParams.get('redirect_uri')).toBeNull();
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('state')).toBeNull();

    const pending = repos.oauth.authRequests.get(requestId as string);
    expect(pending?.clientId).toBe(client.client_id);
    expect(pending?.redirectUri).toBe('https://app.example/callback');
    expect(pending?.codeChallenge).toBe('reto-del-atacante-o-no');
    expect(pending?.state).toBe('estado-1');
    expect(pending?.csrfToken).toBeTruthy();
    expect(pending?.used).toBe(false);
  });

  it('fix round 2 (I4): un scope desconocido se rechaza con InvalidScopeError y no crea ninguna petición pendiente', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const { res } = fakeRes();

    await expect(
      p.authorize(client, {
        redirectUri: 'https://app.example/callback', codeChallenge: 'reto',
        scopes: [MCP_SCOPE, 'admin:root'],
      }, res),
    ).rejects.toThrow(InvalidScopeError);
  });
});

describe('verifyAccessToken — la identidad del sistema', () => {
  it('un token válido devuelve el customerId correcto', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.extra?.customerId).toBe('cus_ana');
    expect(info.clientId).toBe(client.client_id);
    expect(info.scopes).toEqual([MCP_SCOPE]);
  });

  it('dos clientes de banca distintos producen tokens que resuelven a customerId distintos', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const codeAna = issueCode(client, 'cus_ana');
    const codeLuis = issueCode(client, 'cus_luis');
    const tokensAna = await p.exchangeAuthorizationCode(client, codeAna, undefined, client.redirect_uris[0]);
    const tokensLuis = await p.exchangeAuthorizationCode(client, codeLuis, undefined, client.redirect_uris[0]);

    expect((await p.verifyAccessToken(tokensAna.access_token)).extra?.customerId).toBe('cus_ana');
    expect((await p.verifyAccessToken(tokensLuis.access_token)).extra?.customerId).toBe('cus_luis');
  });

  // Tarea OAuth-B (spec §18): `extra.sessionKey` sustituye al id de una fila en `agent_sessions`
  // (tabla eliminada) como identificador de sesión para src/mcp/server.ts y card_refs.
  it('extra.sessionKey es el hash del propio access token, estable entre llamadas', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    const first = await p.verifyAccessToken(tokens.access_token);
    const second = await p.verifyAccessToken(tokens.access_token);

    expect(first.extra?.sessionKey).toBe(hashToken(tokens.access_token));
    expect(first.extra?.sessionKey).toBe(second.extra?.sessionKey);
  });

  it('dos access tokens distintos (incluso del mismo cliente de banca) tienen sessionKey distinta', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const codeA = issueCode(client, 'cus_ana');
    const codeB = issueCode(client, 'cus_ana', { codeChallenge: 'otro-challenge-mas' });
    const tokensA = await p.exchangeAuthorizationCode(client, codeA, undefined, client.redirect_uris[0]);
    const tokensB = await p.exchangeAuthorizationCode(client, codeB, undefined, client.redirect_uris[0]);

    const infoA = await p.verifyAccessToken(tokensA.access_token);
    const infoB = await p.verifyAccessToken(tokensB.access_token);

    expect(infoA.extra?.sessionKey).not.toBe(infoB.extra?.sessionKey);
  });

  it('un token caducado se rechaza con InvalidTokenError', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    clock += 60 * 60 * 1000 + 1; // una hora y un milisegundo después: el access token (TTL 1h) ya caducó.
    await expect(p.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
    await expect(p.verifyAccessToken(tokens.access_token)).rejects.toThrow(/expired/i);
  });

  it('un token revocado se rechaza con InvalidTokenError aunque no haya caducado', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    expect(p.revokeToken).toBeDefined();
    await p.revokeToken!(client, { token: tokens.access_token });
    await expect(p.verifyAccessToken(tokens.access_token)).rejects.toThrow(InvalidTokenError);
    await expect(p.verifyAccessToken(tokens.access_token)).rejects.toThrow(/revoked/i);
  });

  it('un token inexistente se rechaza con InvalidTokenError', async () => {
    const p = provider();
    await expect(p.verifyAccessToken('token-que-nunca-existio')).rejects.toThrow(InvalidTokenError);
    await expect(p.verifyAccessToken('token-que-nunca-existio')).rejects.toThrow(/unrecognized/i);
  });

  it('un refresh token presentado como access token se rechaza con InvalidTokenError', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    expect(tokens.refresh_token).toBeTruthy();
    await expect(p.verifyAccessToken(tokens.refresh_token as string)).rejects.toThrow(InvalidTokenError);
  });
});

describe('exchangeAuthorizationCode — un solo uso', () => {
  it('un código de autorización no se puede canjear dos veces (InvalidGrantError)', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');

    await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);
    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('un código caducado se rechaza con InvalidGrantError', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana', { expiresAt: clock - 1 });

    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('un código emitido a otro cliente se rechaza con InvalidGrantError', async () => {
    const p = provider();
    const clientA = await registerClient(p, ['https://a.example/callback']);
    const clientB = await registerClient(p, ['https://b.example/callback']);
    const code = issueCode(clientA, 'cus_ana');

    await expect(
      p.exchangeAuthorizationCode(clientB, code, undefined, clientB.redirect_uris[0]),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('challengeForAuthorizationCode devuelve el code_challenge guardado, y falla con InvalidGrantError para un código ajeno', async () => {
    const p = provider();
    const clientA = await registerClient(p, ['https://a.example/callback']);
    const clientB = await registerClient(p, ['https://b.example/callback']);
    const code = issueCode(clientA, 'cus_ana', { codeChallenge: 'reto-especifico' });

    expect(await p.challengeForAuthorizationCode(clientA, code)).toBe('reto-especifico');
    await expect(p.challengeForAuthorizationCode(clientB, code)).rejects.toThrow(InvalidGrantError);
  });

  it('una redirect_uri distinta a la de la autorización original se rechaza con InvalidGrantError', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback', 'https://app.example/other']);
    const code = issueCode(client, 'cus_ana', { redirectUri: 'https://app.example/callback' });

    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, 'https://app.example/other'),
    ).rejects.toThrow(InvalidGrantError);
  });
});

describe('exchangeRefreshToken', () => {
  it('emite un access token nuevo para el mismo cliente de banca', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    const refreshed = await p.exchangeRefreshToken(client, tokens.refresh_token as string, undefined, undefined);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const info = await p.verifyAccessToken(refreshed.access_token);
    expect(info.extra?.customerId).toBe('cus_ana');
  });

  it('un refresh token de otro cliente se rechaza con InvalidGrantError', async () => {
    const p = provider();
    const clientA = await registerClient(p, ['https://a.example/callback']);
    const clientB = await registerClient(p, ['https://b.example/callback']);
    const code = issueCode(clientA, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(clientA, code, undefined, clientA.redirect_uris[0]);

    await expect(
      p.exchangeRefreshToken(clientB, tokens.refresh_token as string),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('un refresh token revocado se rechaza con InvalidGrantError', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    await p.revokeToken!(client, { token: tokens.refresh_token as string });
    await expect(
      p.exchangeRefreshToken(client, tokens.refresh_token as string),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('fix round 2 (I2): revocar el access token revoca en cascada el refresh emitido con él', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    await p.revokeToken!(client, { token: tokens.access_token });
    // Antes del fix esto emitía un access token nuevo con toda normalidad.
    await expect(
      p.exchangeRefreshToken(client, tokens.refresh_token as string),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('fix round 2 (I2): el access token emitido por un refresh también queda enlazado a ese refresh', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);
    const refreshed = await p.exchangeRefreshToken(client, tokens.refresh_token as string);

    // Revocar el access token NUEVO (el de la segunda tanda) también debe matar el refresh.
    await p.revokeToken!(client, { token: refreshed.access_token });
    await expect(
      p.exchangeRefreshToken(client, tokens.refresh_token as string),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('fix round 2 (I4): pedir un scope no concedido originalmente se rechaza con InvalidScopeError', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    const code = issueCode(client, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0]);

    await expect(
      p.exchangeRefreshToken(client, tokens.refresh_token as string, ['admin:root']),
    ).rejects.toThrow(InvalidScopeError);
  });
});

describe('revokeToken', () => {
  it('revocar el token de otro cliente no hace nada (silencioso, RFC 7009)', async () => {
    const p = provider();
    const clientA = await registerClient(p, ['https://a.example/callback']);
    const clientB = await registerClient(p, ['https://b.example/callback']);
    const code = issueCode(clientA, 'cus_ana');
    const tokens = await p.exchangeAuthorizationCode(clientA, code, undefined, clientA.redirect_uris[0]);

    await expect(p.revokeToken!(clientB, { token: tokens.access_token })).resolves.toBeUndefined();
    // El token de A sigue siendo válido: B no pudo revocarlo.
    await expect(p.verifyAccessToken(tokens.access_token)).resolves.toBeDefined();
  });

  it('revocar un token inexistente no lanza', async () => {
    const p = provider();
    const client = await registerClient(p, ['https://app.example/callback']);
    await expect(p.revokeToken!(client, { token: 'no-existe' })).resolves.toBeUndefined();
  });
});

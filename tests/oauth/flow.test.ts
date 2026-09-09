import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';
import { hashToken } from '../../src/domain/refs.js';
import { createCardBlockService } from '../../src/services/cardBlockService.js';
import { createApp } from '../../src/server.js';

let app: ReturnType<typeof createApp>;
let repos: Repositories;

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function pkcePair() {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/** Los redirects de /oauth/consent a veces son relativos (a /oauth/consent/login); los de
 * /authorize y los del canje final son absolutos. Una base fija los normaliza a todos. */
function locationUrl(header: string | undefined): URL {
  expect(header).toBeTruthy();
  return new URL(header as string, 'https://gateway.test');
}

function extractCsrfToken(html: string): string {
  const match = html.match(/name="csrf_token" value="([^"]+)"/);
  if (!match) throw new Error('csrf_token no encontrado en la página de consentimiento renderizada.');
  return match[1];
}

beforeEach(() => {
  const db = openDatabase(':memory:');
  repos = createRepositories(db);
  seedDatabase(repos, db);
  const service = createCardBlockService({
    repos, now: () => Date.now(), ttlSeconds: 300, publicBaseUrl: 'https://gateway.test',
  });
  app = createApp({
    service, repos, sessionCookieSecret: 'test-secret',
    publicBaseUrl: 'https://gateway.test', staticDir: null,
  });
});

// Por defecto registra un cliente PÚBLICO (token_endpoint_auth_method: 'none'): es el caso normal
// para un cliente MCP con PKCE obligatorio, y lo que usan la mayoría de estos tests. Los tests que
// necesitan un cliente confidencial (con client_secret real, verificado por el SDK) lo piden
// explícitamente vía `extra`.
async function registerDynamicClient(redirectUri: string, extra: Record<string, unknown> = { token_endpoint_auth_method: 'none' }) {
  const res = await request(app)
    .post('/register')
    .send({ redirect_uris: [redirectUri], client_name: 'AI Findr (test)', ...extra })
    .expect(201);
  return res.body as { client_id: string; client_secret?: string; redirect_uris: string[] };
}

/**
 * Fix round 2: recorre el flujo REAL y autenticado — /authorize crea una petición pendiente en el
 * servidor y redirige con sólo un `request_id`; sin sesión, /oauth/consent lleva a /oauth/consent/login;
 * tras "iniciar sesión" como `customerId`, /oauth/consent muestra el formulario (con su token CSRF)
 * y el POST final emite el código. Usa un `agent` de supertest para persistir la cookie de sesión
 * entre peticiones, exactamente como haría un navegador.
 */
async function authorizeLoginAndConsent(
  clientId: string, redirectUri: string, codeChallenge: string, customerId: string,
  extraAuthorizeParams: Record<string, string> = {},
) {
  const agent = request.agent(app);

  const authRes = await agent
    .get('/authorize')
    .query({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      code_challenge: codeChallenge, code_challenge_method: 'S256', ...extraAuthorizeParams,
    })
    .expect(302);
  const requestId = locationUrl(authRes.header.location).searchParams.get('request_id') as string;
  expect(requestId).toBeTruthy();

  // Sin sesión: el GET lleva a la pantalla de login, conservando el request_id para volver.
  const beforeLogin = await agent.get('/oauth/consent').query({ request_id: requestId }).expect(302);
  const loginUrl = locationUrl(beforeLogin.header.location);
  expect(loginUrl.pathname).toBe('/oauth/consent/login');
  expect(loginUrl.searchParams.get('request_id')).toBe(requestId);

  await agent
    .post('/oauth/consent/login')
    .type('form')
    .send({ request_id: requestId, customer_id: customerId })
    .expect(302);

  const consentPage = await agent.get('/oauth/consent').query({ request_id: requestId }).expect(200);
  const csrfToken = extractCsrfToken(consentPage.text);

  const consentPost = await agent
    .post('/oauth/consent')
    .type('form')
    .send({ request_id: requestId, csrf_token: csrfToken })
    .expect(302);
  const code = locationUrl(consentPost.header.location).searchParams.get('code') as string;
  expect(code).toBeTruthy();

  return { code, agent, requestId, csrfToken };
}

describe('metadata de descubrimiento', () => {
  it('GET /.well-known/oauth-authorization-server anuncia authorize, token y registration_endpoint', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(res.body.issuer).toBe('https://gateway.test/');
    expect(res.body.authorization_endpoint).toBe('https://gateway.test/authorize');
    expect(res.body.token_endpoint).toBe('https://gateway.test/token');
    expect(res.body.registration_endpoint).toBe('https://gateway.test/register');
    expect(res.body.revocation_endpoint).toBe('https://gateway.test/revoke');
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(res.body.scopes_supported).toEqual(['cards:propose']);
  });
});

describe('registro dinámico de clientes', () => {
  it('POST /register da de alta un cliente público y devuelve un client_id sin client_secret', async () => {
    const client = await registerDynamicClient('https://app.example/callback');
    expect(client.client_id).toBeTruthy();
    expect(client.redirect_uris).toEqual(['https://app.example/callback']);
    expect(client.client_secret).toBeUndefined();
  });

  it('un registro confidencial (sin token_endpoint_auth_method: none) recibe un client_secret real', async () => {
    const res = await request(app)
      .post('/register')
      .send({ redirect_uris: ['https://app.example/callback'], client_name: 'Cliente confidencial' })
      .expect(201);
    expect(res.body.client_secret).toBeTruthy();
  });
});

describe('client_secret: verificación real en /token (fix round 1)', () => {
  it('un cliente confidencial con client_secret incorrecto recibe 400 en /token, no 200', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri, {});
    expect(client.client_secret).toBeTruthy(); // el SDK generó uno de verdad

    const { codeVerifier, codeChallenge } = pkcePair();
    const { code } = await authorizeLoginAndConsent(client.client_id, redirectUri, codeChallenge, 'cus_ana');

    const bad = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        code_verifier: codeVerifier, client_id: client.client_id, client_secret: 'esto-es-completamente-falso',
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_client');
  });

  it('un cliente confidencial con el client_secret correcto sí recibe 200 en /token', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri, {});

    const { codeVerifier, codeChallenge } = pkcePair();
    const { code } = await authorizeLoginAndConsent(client.client_id, redirectUri, codeChallenge, 'cus_ana');

    const ok = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        code_verifier: codeVerifier, client_id: client.client_id, client_secret: client.client_secret,
      })
      .expect(200);
    expect(ok.body.access_token).toBeTruthy();
  });

  it('un cliente público canjea su código en /token sin enviar client_secret alguno', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri); // público por defecto
    expect(client.client_secret).toBeUndefined();

    const { codeVerifier, codeChallenge } = pkcePair();
    const { code } = await authorizeLoginAndConsent(client.client_id, redirectUri, codeChallenge, 'cus_ana');

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: client.client_id })
      .expect(200);
    expect(res.body.access_token).toBeTruthy();
  });
});

describe('el agujero clásico: redirect_uri no registrada', () => {
  it('GET /authorize con una redirect_uri no registrada responde 400 y NO redirige', async () => {
    const client = await registerDynamicClient('https://app.example/callback');
    const { codeChallenge } = pkcePair();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: client.client_id,
        redirect_uri: 'https://evil.example/steal',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

    expect(res.status).toBe(400);
    expect(res.header.location).toBeUndefined();
  });

  it('POST /oauth/consent ignora cualquier redirect_uri que venga en el cuerpo: usa la de la petición pendiente del servidor', async () => {
    // Fix round 2: el formulario ya NO transporta redirect_uri (ni client_id, ni code_challenge,
    // ni scope) — sólo request_id y csrf_token. Un redirect_uri "de propina" en el cuerpo no tiene
    // ningún efecto: la redirección final sigue yendo a la única redirect_uri registrada.
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri);
    const { codeChallenge } = pkcePair();

    const agent = request.agent(app);
    const authRes = await agent
      .get('/authorize')
      .query({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: codeChallenge, code_challenge_method: 'S256' })
      .expect(302);
    const requestId = locationUrl(authRes.header.location).searchParams.get('request_id') as string;
    await agent.post('/oauth/consent/login').type('form').send({ request_id: requestId, customer_id: 'cus_ana' }).expect(302);
    const consentPage = await agent.get('/oauth/consent').query({ request_id: requestId }).expect(200);
    const csrfToken = extractCsrfToken(consentPage.text);

    const consentPost = await agent
      .post('/oauth/consent')
      .type('form')
      .send({ request_id: requestId, csrf_token: csrfToken, redirect_uri: 'https://evil.example/steal' })
      .expect(302);
    const finalUrl = locationUrl(consentPost.header.location);
    expect(finalUrl.origin + finalUrl.pathname).toBe(redirectUri);
  });
});

describe('flujo completo: authorize → login → consentimiento → token → /mcp', () => {
  it('un access token emitido por el flujo permite tools/list en /mcp', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri);
    const { codeVerifier, codeChallenge } = pkcePair();

    const agent = request.agent(app);

    // 1. /authorize crea la petición pendiente en el servidor y redirige con sólo un request_id.
    const authRes = await agent
      .get('/authorize')
      .query({
        client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
        code_challenge: codeChallenge, code_challenge_method: 'S256', state: 'estado-123',
        scope: 'cards:propose',
      })
      .expect(302);
    const consentUrl = locationUrl(authRes.header.location);
    expect(consentUrl.pathname).toBe('/oauth/consent');
    const requestId = consentUrl.searchParams.get('request_id');
    expect(requestId).toBeTruthy();
    expect(consentUrl.searchParams.get('client_id')).toBeNull(); // ya no viaja en la URL

    // 2. Sin sesión, el GET lleva a /oauth/consent/login.
    const beforeLogin = await agent.get('/oauth/consent').query({ request_id: requestId }).expect(302);
    expect(locationUrl(beforeLogin.header.location).pathname).toBe('/oauth/consent/login');

    // 3. Login simulado: elige cus_ana, se fija la cookie de sesión.
    await agent.post('/oauth/consent/login').type('form').send({ request_id: requestId, customer_id: 'cus_ana' }).expect(302);

    // 4. Ahora sí, GET /oauth/consent muestra el formulario (con el token CSRF embebido).
    const consentPage = await agent.get('/oauth/consent').query({ request_id: requestId }).expect(200);
    expect(consentPage.text).toContain('cus_ana');
    const csrfToken = extractCsrfToken(consentPage.text);

    // 5. POST /oauth/consent (con sesión + CSRF) redirige con `code` y el mismo `state`.
    const consentPost = await agent
      .post('/oauth/consent')
      .type('form')
      .send({ request_id: requestId, csrf_token: csrfToken })
      .expect(302);
    const finalRedirect = locationUrl(consentPost.header.location);
    expect(finalRedirect.origin + finalRedirect.pathname).toBe(redirectUri);
    expect(finalRedirect.searchParams.get('state')).toBe('estado-123');
    const code = finalRedirect.searchParams.get('code');
    expect(code).toBeTruthy();

    // 6. POST /token intercambia el código (con PKCE) por un access + refresh token.
    const tokenRes = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        code_verifier: codeVerifier, client_id: client.client_id,
      })
      .expect(200);
    expect(tokenRes.body.access_token).toBeTruthy();
    expect(tokenRes.body.refresh_token).toBeTruthy();
    expect(tokenRes.body.token_type).toBe('bearer');

    // 7. El código ya no se puede reusar.
    await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        code_verifier: codeVerifier, client_id: client.client_id,
      })
      .expect(400);

    // 8. El access token permite tools/list en /mcp.
    const mcpRes = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokenRes.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);
    expect(mcpRes.text).toContain('list_debit_cards');
    expect(mcpRes.text).toContain('propose_card_block');

    // 9. Un token inventado se rechaza con 401.
    await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer token-que-nunca-existio')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      .expect(401);

    // 10. Sin cabecera Authorization también se rechaza.
    await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
      .expect(401);
  });
});

describe('fix round 2 — CRITICAL: identidad seleccionada vs. autenticada', () => {
  it('reproduce la cadena de ataque completa y confirma que ahora se corta en el primer paso sin sesión', async () => {
    // Exactamente la cadena que demostró el CRITICAL: registro propio -> POST /oauth/consent
    // directo, sin navegador, sin cookie, con `customer_id` ajeno en el cuerpo -> antes: 302 con
    // código de otro cliente. Ahora: 401, sin request_id siquiera necesario para que falle, porque
    // la comprobación de sesión es lo primero que hace el handler.
    const redirectUri = 'https://attacker.example/callback';
    const attackerClient = await registerDynamicClient(redirectUri);

    const attack = await request(app)
      .post('/oauth/consent')
      .type('form')
      .send({
        client_id: attackerClient.client_id, // ya ni se lee, pero se manda por fidelidad al ataque original
        customer_id: 'cus_luis', // el cliente de banca ajeno que el atacante intentaba suplantar
      });

    expect(attack.status).toBe(401);
    expect(attack.header.location).toBeUndefined(); // nunca llega a emitir ni redirigir con un code
  });

  it('POST /oauth/consent sin cookie de sesión responde 401, incluso con un request_id real y válido', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri);
    const { codeChallenge } = pkcePair();

    const authRes = await request(app)
      .get('/authorize')
      .query({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: codeChallenge, code_challenge_method: 'S256' })
      .expect(302);
    const requestId = locationUrl(authRes.header.location).searchParams.get('request_id') as string;

    // Sin agent (sin cookie), y sin siquiera pasar por login: intento directo con un request_id
    // real, csrf_token inventado y customer_id ajeno.
    const res = await request(app)
      .post('/oauth/consent')
      .type('form')
      .send({ request_id: requestId, csrf_token: 'lo-que-sea', customer_id: 'cus_luis' });

    expect(res.status).toBe(401);
  });

  it('el customer_id del cuerpo se ignora: el código queda ligado al customer_id de la cookie, no al del formulario', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri);
    const { codeVerifier, codeChallenge } = pkcePair();

    const agent = request.agent(app);
    const authRes = await agent
      .get('/authorize')
      .query({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: codeChallenge, code_challenge_method: 'S256' })
      .expect(302);
    const requestId = locationUrl(authRes.header.location).searchParams.get('request_id') as string;

    // Inicia sesión legítimamente como cus_ana.
    await agent.post('/oauth/consent/login').type('form').send({ request_id: requestId, customer_id: 'cus_ana' }).expect(302);
    const consentPage = await agent.get('/oauth/consent').query({ request_id: requestId }).expect(200);
    const csrfToken = extractCsrfToken(consentPage.text);

    // Pero en el POST intenta colar customer_id=cus_luis en el cuerpo.
    const consentPost = await agent
      .post('/oauth/consent')
      .type('form')
      .send({ request_id: requestId, csrf_token: csrfToken, customer_id: 'cus_luis' })
      .expect(302);
    const code = locationUrl(consentPost.header.location).searchParams.get('code') as string;

    const tokenRes = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: client.client_id })
      .expect(200);

    // El access token debe resolver a cus_ana (la sesión real de la cookie), NUNCA a cus_luis (lo
    // que mandó el formulario). Se comprueba donde vive de verdad: la fila del token en la base de
    // datos — que las tools MCP acaben leyendo exactamente este customerId, y ninguna otra cosa,
    // se prueba end-to-end en el describe 'tarea OAuth-B' más abajo.
    const row = repos.oauth.tokens.getByHash(hashToken(tokenRes.body.access_token as string));
    expect(row?.customerId).toBe('cus_ana');
    expect(row?.customerId).not.toBe('cus_luis');
  });

  it('un request_id ya usado no se puede reproducir: el segundo POST /oauth/consent falla', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri);
    const { codeChallenge } = pkcePair();

    const { agent, requestId, csrfToken } = await authorizeLoginAndConsent(client.client_id, redirectUri, codeChallenge, 'cus_ana');

    const replay = await agent.post('/oauth/consent').type('form').send({ request_id: requestId, csrf_token: csrfToken });
    expect(replay.status).toBe(400);
    expect(replay.header.location).toBeUndefined();
  });

  it('POST /oauth/consent sin csrf_token (o con uno incorrecto) se rechaza, aunque haya sesión y request_id válidos', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri);
    const { codeChallenge } = pkcePair();

    const agent = request.agent(app);
    const authRes = await agent
      .get('/authorize')
      .query({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: codeChallenge, code_challenge_method: 'S256' })
      .expect(302);
    const requestId = locationUrl(authRes.header.location).searchParams.get('request_id') as string;
    await agent.post('/oauth/consent/login').type('form').send({ request_id: requestId, customer_id: 'cus_ana' }).expect(302);

    const sinToken = await agent.post('/oauth/consent').type('form').send({ request_id: requestId });
    expect(sinToken.status).toBe(403);

    const tokenIncorrecto = await agent.post('/oauth/consent').type('form').send({ request_id: requestId, csrf_token: 'esto-no-es-el-token-correcto' });
    expect(tokenIncorrecto.status).toBe(403);
  });

  it('fix round 2 (I4): un scope desconocido en /authorize redirige con error=invalid_scope y no llega a crear ningún código', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri);
    const { codeChallenge } = pkcePair();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
        code_challenge: codeChallenge, code_challenge_method: 'S256', scope: 'cards:propose admin:root',
      })
      .expect(302);
    const url = locationUrl(res.header.location);
    expect(url.origin + url.pathname).toBe(redirectUri);
    expect(url.searchParams.get('error')).toBe('invalid_scope');
    expect(url.searchParams.get('code')).toBeNull();
  });

  it('fix round 2 (I2): tras revocar el access token, canjear su refresh token en /token se rechaza (no da un access nuevo)', async () => {
    const redirectUri = 'https://app.example/callback';
    const client = await registerDynamicClient(redirectUri);
    const { codeVerifier, codeChallenge } = pkcePair();
    const { code } = await authorizeLoginAndConsent(client.client_id, redirectUri, codeChallenge, 'cus_ana');

    const tokenRes = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: client.client_id })
      .expect(200);

    await request(app)
      .post('/revoke')
      .send({ token: tokenRes.body.access_token, client_id: client.client_id })
      .expect(200);

    // Antes del fix esto devolvía 200 con un access token nuevo.
    const refreshAttempt = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokenRes.body.refresh_token, client_id: client.client_id });
    expect(refreshAttempt.status).toBe(400);
    expect(refreshAttempt.body.error).toBe('invalid_grant');
  });
});

describe('tarea OAuth-B: la identidad de las tools la lleva el access token, no el contenido', () => {
  /** Recorre el flujo OAuth real de punta a punta (registro, login simulado, consentimiento,
   * canje) para `customerId` y devuelve un access token real, del mismo tipo que usaría AI Findr. */
  async function issueAccessToken(customerId: string): Promise<string> {
    const redirectUri = `https://app.example/callback-${customerId}-${Math.random().toString(16).slice(2)}`;
    const client = await registerDynamicClient(redirectUri);
    const { codeVerifier, codeChallenge } = pkcePair();
    const { code } = await authorizeLoginAndConsent(client.client_id, redirectUri, codeChallenge, customerId);
    const tokenRes = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        code_verifier: codeVerifier, client_id: client.client_id,
      })
      .expect(200);
    return tokenRes.body.access_token as string;
  }

  async function callTool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
    return request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
  }

  /** El transporte Streamable HTTP responde en `application/json` (cuerpo ya parseado por
   * supertest) o, si toca streaming, como SSE (`res.text` con líneas `data: {...}`) — se acepta
   * cualquiera de los dos formatos, para no acoplar el test a un detalle interno del transporte. */
  function resultText(res: { body: unknown; text: string }): string {
    const body = res.body as { result?: { content: Array<{ text: string }> } } | undefined;
    if (body?.result) return body.result.content[0].text;
    const match = res.text.match(/data: (\{.*\})/);
    if (!match) throw new Error(`No se pudo extraer la respuesta JSON-RPC de:\n${res.text}`);
    const payload = JSON.parse(match[1]) as { result: { content: Array<{ text: string }> } };
    return payload.result.content[0].text;
  }

  it('sin cabecera Authorization, la llamada a la tool nunca llega a ejecutarse (401 antes de cualquier tool)', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_debit_cards', arguments: {} } });
    expect(res.status).toBe(401);
  });

  it('list_debit_cards devuelve las tarjetas del cliente que identifica el access token, nunca las de otro (C1)', async () => {
    const anaToken = await issueAccessToken('cus_ana');
    const luisToken = await issueAccessToken('cus_luis');

    const anaCards = JSON.parse(resultText(await callTool(anaToken, 'list_debit_cards'))).cards as Array<{ cardRef: string }>;
    const luisCards = JSON.parse(resultText(await callTool(luisToken, 'list_debit_cards'))).cards as Array<{ cardRef: string }>;

    expect(anaCards.length).toBeGreaterThan(0);
    expect(luisCards.length).toBeGreaterThan(0);
    const anaRefs = anaCards.map((c) => c.cardRef);
    const luisRefs = luisCards.map((c) => c.cardRef);
    expect(anaRefs.some((r) => luisRefs.includes(r))).toBe(false);
  });

  it('un card_ref obtenido con el access token de un cliente no resuelve con el access token de otro', async () => {
    const anaToken = await issueAccessToken('cus_ana');
    const luisToken = await issueAccessToken('cus_luis');

    const anaCards = JSON.parse(resultText(await callTool(anaToken, 'list_debit_cards'))).cards as Array<{ cardRef: string }>;
    const refAna = anaCards[0].cardRef;

    // Con el token de otro cliente, el ref de Ana no resuelve — "no encontrado", igual que un ref
    // inventado, nunca "prohibido" (C1, el mismo criterio que a nivel de servicio).
    const ajeno = resultText(await callTool(luisToken, 'propose_card_block', { card_ref: refAna, reason: 'STOLEN' }));
    expect(ajeno).toMatch(/does not exist in this session/i);

    // Control: con su propio token, ese mismo ref sí resuelve — así que el fallo de arriba es
    // aislamiento real, no una tool rota.
    const propio = JSON.parse(resultText(await callTool(anaToken, 'propose_card_block', { card_ref: refAna, reason: 'STOLEN' })));
    expect(propio).toHaveProperty('proposalId');
  });
});

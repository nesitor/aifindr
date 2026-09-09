import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Repositories } from '../db/repositories.js';
import { hashToken, newId } from '../domain/refs.js';

/** Único scope que existe en este sistema. */
export const MCP_SCOPE = 'cards:propose';

/** Fix round 2 (I4): lista cerrada de scopes soportados. Cualquier otro se rechaza. */
export const SUPPORTED_SCOPES: readonly string[] = [MCP_SCOPE];

const ONE_HOUR_MS = 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

export interface OAuthProviderDeps {
  repos: Repositories;
  /** URL pública de este gateway (raíz del túnel), usada para construir el redirect a /oauth/consent. */
  publicBaseUrl: string;
  now?: () => number;
  /** Decisiones no fijadas por el brief, con valores por defecto documentados en el informe. */
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
  authorizationCodeTtlMs?: number;
  /** TTL de la petición de autorización pendiente (fix round 2): más largo que el del código,
   * porque de por medio puede haber un salto a la pantalla de login. */
  authorizationRequestTtlMs?: number;
}

function toClientInfo(c: {
  clientId: string; clientSecret: string | null; clientSecretExpiresAt: number | null;
  clientName: string | null; redirectUris: string[];
}): OAuthClientInformationFull {
  const info: OAuthClientInformationFull = {
    client_id: c.clientId,
    client_name: c.clientName ?? undefined,
    redirect_uris: c.redirectUris,
  };
  // El middleware `authenticateClient` del SDK (usado internamente por /token y /revoke) compara
  // el secreto que envía el cliente contra este mismo campo, en claro. Devolverlo aquí para un
  // cliente confidencial es lo que hace real esa verificación; omitirlo (clientSecret === null,
  // el caso normal de un cliente público con PKCE) hace que el SDK trate al cliente como público
  // y no exija ningún secreto — correcto, porque nunca se le asignó uno.
  if (c.clientSecret) {
    info.client_secret = c.clientSecret;
    // Fix round 2 (I3): sin esto, `authenticateClient` nunca ejecuta su comprobación de caducidad
    // (`if (client.client_secret_expires_at && ...)`) y el secreto queda eterno de facto.
    if (c.clientSecretExpiresAt !== null) info.client_secret_expires_at = c.clientSecretExpiresAt;
  }
  return info;
}

function validateScopes(requested: string[]): void {
  const unknown = requested.filter((s) => !SUPPORTED_SCOPES.includes(s));
  if (unknown.length > 0) {
    throw new InvalidScopeError(`Unsupported scope: ${unknown.join(', ')}`);
  }
}

/**
 * Proveedor OAuth 2.1 respaldado por SQLite. Implementa `OAuthServerProvider` del SDK de MCP.
 *
 * `verifyAccessToken` es el método del que cuelga toda la identidad del sistema: rechaza
 * cualquier token inexistente, revocado o caducado, y nunca devuelve el `customerId` de un
 * cliente de banca que no sea el dueño real del token.
 *
 * Fix round 2: `authorize()` ya NO delega en el formulario de consentimiento la elección de
 * `code_challenge` ni de cliente de banca — eso permitía a cualquiera saltarse `/authorize` y
 * `POST /oauth/consent` directamente con su propio `code_challenge` y un `customer_id` ajeno (ver
 * `src/oauth/consent.ts`, que ahora exige sesión web y lee el `customer_id` de la cookie, nunca
 * del cuerpo). Aquí sólo se guarda la petición pendiente y se valida el scope.
 */
export function createOAuthProvider(deps: OAuthProviderDeps): OAuthServerProvider {
  const { repos } = deps;
  const now = deps.now ?? (() => Date.now());
  const accessTokenTtlMs = deps.accessTokenTtlMs ?? ONE_HOUR_MS;
  const refreshTokenTtlMs = deps.refreshTokenTtlMs ?? THIRTY_DAYS_MS;
  const authorizationCodeTtlMs = deps.authorizationCodeTtlMs ?? FIVE_MINUTES_MS;
  const authorizationRequestTtlMs = deps.authorizationRequestTtlMs ?? TEN_MINUTES_MS;

  function issueAccessToken(
    clientId: string, customerId: string, scopes: string[], linkedTokenHash: string | null,
  ): { token: string; expiresAt: number } {
    const token = newId('oat');
    const expiresAt = now() + accessTokenTtlMs;
    repos.oauth.tokens.save({
      tokenHash: hashToken(token), type: 'access', clientId, customerId, scopes, expiresAt,
      revoked: false, linkedTokenHash,
    });
    return { token, expiresAt };
  }

  return {
    get clientsStore() {
      return {
        getClient: (clientId: string): OAuthClientInformationFull | undefined => {
          const c = repos.oauth.clients.get(clientId);
          return c ? toClientInfo(c) : undefined;
        },

        registerClient: (
          client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
        ): OAuthClientInformationFull => {
          const clientId = newId('client');
          const issuedAt = Math.floor(now() / 1000);
          // Un cliente público (token_endpoint_auth_method: 'none') no recibe secreto — es el
          // caso normal para un cliente MCP, que se apoya en PKCE (obligatorio) en su lugar. El
          // router del SDK ya deja `client.client_secret` sin definir en ese caso; se comprueba
          // también `token_endpoint_auth_method` por si acaso, para no depender únicamente de eso.
          const isPublicClient = client.token_endpoint_auth_method === 'none' || !client.client_secret;

          repos.oauth.clients.save({
            clientId,
            // Recuperable (NO hasheado) para un cliente confidencial: ver el comentario sobre
            // `oauth_clients.client_secret` en schema.sql — lo exige el modelo de comparación en
            // claro de `authenticateClient`, que no tiene ningún punto de extensión.
            clientSecret: isPublicClient ? null : (client.client_secret ?? null),
            clientSecretExpiresAt: isPublicClient ? null : (client.client_secret_expires_at ?? null),
            clientName: client.client_name ?? null,
            redirectUris: client.redirect_uris,
            createdAt: now(),
          });

          const result: OAuthClientInformationFull = { ...client, client_id: clientId, client_id_issued_at: issuedAt };
          if (isPublicClient) {
            // Un cliente público no tiene secreto: devolverlo (aunque fuera `undefined`) podría
            // hacerle creer que es confidencial. Se elimina explícitamente en vez de confiar en
            // que la serialización JSON descarte los campos `undefined`.
            delete result.client_secret;
            delete result.client_secret_expires_at;
          }
          return result;
        },
      };
    },

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      const requestedScopes = params.scopes && params.scopes.length > 0 ? params.scopes : [MCP_SCOPE];
      // Fix round 2 (I4): un scope desconocido se rechaza aquí, antes de crear nada. El SDK
      // convierte esta excepción en una redirección de error a `redirect_uri` (fase 2 de
      // `authorizationHandler`), no en una respuesta directa — es el comportamiento estándar.
      validateScopes(requestedScopes);

      // Fix round 2 (CRITICAL): la petición vive en el servidor, no en la URL ni en el
      // formulario. Lo único que cruza a /oauth/consent es un identificador opaco de un solo uso.
      // Sin esto, quien controla el navegador controla también `code_challenge` y podía llamar a
      // POST /oauth/consent directamente, sin pasar por aquí ni por ninguna sesión.
      const requestId = newId('areq');
      const csrfToken = newId('csrf');
      repos.oauth.authRequests.save({
        requestId,
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes: requestedScopes,
        state: params.state ?? null,
        csrfToken,
        expiresAt: now() + authorizationRequestTtlMs,
        used: false,
      });

      const url = new URL('/oauth/consent', deps.publicBaseUrl);
      url.searchParams.set('request_id', requestId);
      res.redirect(302, url.href);
    },

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
      const row = repos.oauth.codes.get(authorizationCode);
      if (!row || row.used || row.expiresAt <= now() || row.clientId !== client.client_id) {
        throw new InvalidGrantError('The authorization code does not exist, was already used, has expired, or was not issued to this client.');
      }
      return row.codeChallenge;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      redirectUri?: string,
    ): Promise<OAuthTokens> {
      const t = now();
      // Atómico y de un solo uso: si ya se consumió (incluida una carrera entre dos peticiones
      // simultáneas con el mismo código), `consume` devuelve null y no se emite nada.
      const row = repos.oauth.codes.consume(authorizationCode, t);
      if (!row) {
        throw new InvalidGrantError('The authorization code does not exist, was already used, or has expired.');
      }
      if (row.clientId !== client.client_id) {
        throw new InvalidGrantError('The authorization code was not issued to this client.');
      }
      if (redirectUri !== undefined && redirectUri !== row.redirectUri) {
        throw new InvalidGrantError('redirect_uri does not match the one used in the original authorization.');
      }

      // Fix round 2 (I2): el access y el refresh se enlazan (el access guarda el hash del refresh
      // emitido junto a él) para poder revocar en cascada — ver revokeToken más abajo.
      const refreshToken = newId('ort');
      const refreshTokenHash = hashToken(refreshToken);
      const access = issueAccessToken(client.client_id, row.customerId, row.scopes, refreshTokenHash);
      repos.oauth.tokens.save({
        tokenHash: refreshTokenHash, type: 'refresh', clientId: client.client_id,
        customerId: row.customerId, scopes: row.scopes, expiresAt: t + refreshTokenTtlMs,
        revoked: false, linkedTokenHash: null,
      });

      return {
        access_token: access.token,
        token_type: 'bearer',
        expires_in: Math.floor(accessTokenTtlMs / 1000),
        refresh_token: refreshToken,
        scope: row.scopes.join(' '),
      };
    },

    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      scopes?: string[],
    ): Promise<OAuthTokens> {
      const t = now();
      const refreshTokenHash = hashToken(refreshToken);
      const row = repos.oauth.tokens.getByHash(refreshTokenHash);
      if (!row || row.type !== 'refresh' || row.revoked || row.expiresAt <= t) {
        throw new InvalidGrantError('The refresh token does not exist, was revoked, or has expired.');
      }
      if (row.clientId !== client.client_id) {
        throw new InvalidGrantError('The refresh token was not issued to this client.');
      }

      // RFC 6749 §6: un refresh puede pedir un subconjunto del scope original, nunca ampliarlo.
      // Fix round 2 (I4): además, cualquier scope pedido debe seguir en la lista soportada.
      let grantedScopes = row.scopes;
      if (scopes && scopes.length > 0) {
        validateScopes(scopes);
        const notGranted = scopes.filter((s) => !row.scopes.includes(s));
        if (notGranted.length > 0) {
          throw new InvalidScopeError(`Scope not granted in the original authorization: ${notGranted.join(', ')}`);
        }
        grantedScopes = scopes;
      }

      // El mismo refresh token se reutiliza (no rota) hasta que caduque o se revoque, pero el
      // access token nuevo se enlaza a él igualmente: revocar ESTE access también revoca el
      // refresh compartido.
      const access = issueAccessToken(client.client_id, row.customerId, grantedScopes, refreshTokenHash);
      return {
        access_token: access.token,
        token_type: 'bearer',
        expires_in: Math.floor(accessTokenTtlMs / 1000),
        scope: grantedScopes.join(' '),
      };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const tokenHash = hashToken(token);
      const row = repos.oauth.tokens.getByHash(tokenHash);
      if (!row) throw new InvalidTokenError('Unrecognized token.');
      if (row.type !== 'access') throw new InvalidTokenError('The token is not an access token.');
      if (row.revoked) throw new InvalidTokenError('The token has been revoked.');
      if (row.expiresAt <= now()) throw new InvalidTokenError('The token has expired.');

      return {
        token,
        clientId: row.clientId,
        scopes: row.scopes,
        // AuthInfo.expiresAt está en epoch-segundos (lo compara `requireBearerAuth` contra
        // Date.now() / 1000); el resto del sistema usa epoch-milisegundos, de ahí la conversión.
        expiresAt: Math.floor(row.expiresAt / 1000),
        // `sessionKey` (tarea OAuth-B, spec §18): sustituye al id de una fila en `agent_sessions`
        // (tabla que ya no existe) como identificador de sesión. Es el hash del access token, ya
        // calculado arriba para buscar la fila — reutilizarlo evita hashear dos veces y, sobre
        // todo, hace que la sesión sea indistinguible de "este access token concreto": mismo
        // token, misma sesión; token distinto (de otro cliente, o el mismo tras revocar y volver
        // a autorizar), sesión distinta. `src/mcp/server.ts` exige que ambos campos estén
        // presentes antes de invocar ninguna tool.
        extra: { customerId: row.customerId, sessionKey: tokenHash },
      };
    },

    async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
      const hash = hashToken(request.token);
      const row = repos.oauth.tokens.getByHash(hash);
      // Silencioso si no existe o pertenece a otro cliente (RFC 7009): no hay nada que confirmar.
      if (!row || row.clientId !== client.client_id) return;
      repos.oauth.tokens.revoke(hash);
      // Fix round 2 (I2): revocar un access revoca en cascada el refresh emitido junto a él, para
      // que no se pueda seguir canjeando por accesos nuevos después de revocado.
      if (row.type === 'access' && row.linkedTokenHash) {
        repos.oauth.tokens.revoke(row.linkedTokenHash);
      }
    },
  };
}

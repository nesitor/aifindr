import type Database from 'better-sqlite3';
import type { ActorType, AuditEntry, Card, CardStatus, Customer, Proposal } from '../domain/types.js';

interface CustomerRow { id: string; name: string }
interface CardRow { id: string; customer_id: string; last4: string; brand: string; type: string; status: string; is_flaky: number }
interface ProposalRow { id: string; session_id: string; customer_id: string; card_id: string; action: string; reason: string; note: string | null; status: string; idempotency_key: string; created_at: number; expires_at: number; confirmed_at: number | null; executed_at: number | null; failure_reason: string | null }
interface AuditRow { id: number; ts: number; customer_id: string; actor_type: string; actor_id: string; event: string; proposal_id: string | null; card_id: string | null; details_json: string }

const toCard = (r: CardRow): Card => ({
  id: r.id, customerId: r.customer_id, last4: r.last4, brand: r.brand,
  type: 'debit', status: r.status as CardStatus, isFlaky: r.is_flaky === 1,
});

const toProposal = (r: ProposalRow): Proposal => ({
  id: r.id, sessionId: r.session_id, customerId: r.customer_id, cardId: r.card_id,
  action: 'card.block', reason: r.reason as Proposal['reason'], note: r.note,
  status: r.status as Proposal['status'], idempotencyKey: r.idempotency_key,
  createdAt: r.created_at, expiresAt: r.expires_at,
  confirmedAt: r.confirmed_at, executedAt: r.executed_at, failureReason: r.failure_reason,
});

const toAudit = (r: AuditRow): AuditEntry => ({
  id: r.id, ts: r.ts, customerId: r.customer_id, actorType: r.actor_type as ActorType, actorId: r.actor_id,
  event: r.event, proposalId: r.proposal_id, cardId: r.card_id,
  details: JSON.parse(r.details_json) as Record<string, unknown>,
});

// --- OAuth 2.1 (canal MCP) ---------------------------------------------------------------

interface OAuthClientRow {
  client_id: string; client_secret: string | null; client_secret_expires_at: number | null;
  client_name: string | null; redirect_uris: string; created_at: number;
}
interface OAuthCodeRow {
  code: string; client_id: string; customer_id: string; redirect_uri: string; code_challenge: string;
  code_challenge_method: string; scopes: string; expires_at: number; used: number;
}
interface OAuthTokenRow {
  token_hash: string; type: string; client_id: string; customer_id: string; scopes: string;
  expires_at: number; revoked: number; linked_token_hash: string | null;
}
interface OAuthAuthRequestRow {
  request_id: string; client_id: string; redirect_uri: string; code_challenge: string; scopes: string;
  state: string | null; csrf_token: string; expires_at: number; used: number;
}

export interface OAuthClientRecord {
  clientId: string;
  /** Recuperable (NO hasheado): ver el comentario sobre `oauth_clients.client_secret` en schema.sql. */
  clientSecret: string | null;
  /** Epoch en SEGUNDOS (no ms) — ver el comentario en schema.sql. */
  clientSecretExpiresAt: number | null;
  clientName: string | null; redirectUris: string[]; createdAt: number;
}
export interface OAuthCodeRecord {
  code: string; clientId: string; customerId: string; redirectUri: string; codeChallenge: string;
  codeChallengeMethod: string; scopes: string[]; expiresAt: number; used: boolean;
}
export interface OAuthTokenRecord {
  tokenHash: string; type: 'access' | 'refresh'; clientId: string; customerId: string;
  scopes: string[]; expiresAt: number; revoked: boolean;
  /** Sólo relevante en un token de tipo 'access': hash del refresh emitido junto a él (fix I2). */
  linkedTokenHash: string | null;
}
export interface OAuthAuthRequestRecord {
  requestId: string; clientId: string; redirectUri: string; codeChallenge: string;
  scopes: string[]; state: string | null; csrfToken: string; expiresAt: number; used: boolean;
}

const toOAuthClient = (r: OAuthClientRow): OAuthClientRecord => ({
  clientId: r.client_id, clientSecret: r.client_secret, clientSecretExpiresAt: r.client_secret_expires_at,
  clientName: r.client_name, redirectUris: JSON.parse(r.redirect_uris) as string[], createdAt: r.created_at,
});

const toOAuthCode = (r: OAuthCodeRow): OAuthCodeRecord => ({
  code: r.code, clientId: r.client_id, customerId: r.customer_id, redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge, codeChallengeMethod: r.code_challenge_method,
  scopes: JSON.parse(r.scopes) as string[], expiresAt: r.expires_at, used: r.used === 1,
});

const toOAuthToken = (r: OAuthTokenRow): OAuthTokenRecord => ({
  tokenHash: r.token_hash, type: r.type as OAuthTokenRecord['type'], clientId: r.client_id,
  customerId: r.customer_id, scopes: JSON.parse(r.scopes) as string[], expiresAt: r.expires_at,
  revoked: r.revoked === 1, linkedTokenHash: r.linked_token_hash,
});

const toOAuthAuthRequest = (r: OAuthAuthRequestRow): OAuthAuthRequestRecord => ({
  requestId: r.request_id, clientId: r.client_id, redirectUri: r.redirect_uri, codeChallenge: r.code_challenge,
  scopes: JSON.parse(r.scopes) as string[], state: r.state, csrfToken: r.csrf_token,
  expiresAt: r.expires_at, used: r.used === 1,
});

export function createRepositories(db: Database.Database) {
  return {
    customers: {
      /** Orden estable por id: las pantallas de login los muestran en este orden. */
      list: (): Customer[] =>
        db.prepare('SELECT id, name FROM customers ORDER BY id').all() as CustomerRow[],
      byId: (id: string): Customer | null =>
        (db.prepare('SELECT id, name FROM customers WHERE id = ?').get(id) as CustomerRow | undefined) ?? null,
    },

    cards: {
      byId: (id: string): Card | null => {
        const r = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
        return r ? toCard(r) : null;
      },
      byCustomer: (customerId: string): Card[] =>
        (db.prepare('SELECT * FROM cards WHERE customer_id = ? ORDER BY id').all(customerId) as CardRow[]).map(toCard),
      setStatus: (id: string, status: CardStatus): void => {
        db.prepare('UPDATE cards SET status = ? WHERE id = ?').run(status, id);
      },
    },

    cardRefs: {
      put: (sessionKey: string, ref: string, cardId: string): void => {
        db.prepare('INSERT OR REPLACE INTO card_refs (session_key, ref, card_id) VALUES (?, ?, ?)').run(sessionKey, ref, cardId);
      },
      resolve: (sessionKey: string, ref: string): string | null => {
        const r = db.prepare('SELECT card_id FROM card_refs WHERE session_key = ? AND ref = ?').get(sessionKey, ref) as
          | { card_id: string }
          | undefined;
        return r ? r.card_id : null;
      },
    },

    proposals: {
      insert: (p: Proposal): void => {
        db.prepare(
          `INSERT INTO proposals (id, session_id, customer_id, card_id, action, reason, note, status,
             idempotency_key, created_at, expires_at, confirmed_at, executed_at, failure_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(p.id, p.sessionId, p.customerId, p.cardId, p.action, p.reason, p.note, p.status,
              p.idempotencyKey, p.createdAt, p.expiresAt, p.confirmedAt, p.executedAt, p.failureReason);
      },
      byId: (id: string): Proposal | null => {
        const r = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
        return r ? toProposal(r) : null;
      },
      byLiveIdempotencyKey: (key: string, now: number): Proposal | null => {
        const r = db.prepare(
          "SELECT * FROM proposals WHERE idempotency_key = ? AND status = 'PROPOSED' AND expires_at > ?",
        ).get(key, now) as ProposalRow | undefined;
        return r ? toProposal(r) : null;
      },
      byCustomer: (customerId: string): Proposal[] =>
        (db.prepare('SELECT * FROM proposals WHERE customer_id = ? ORDER BY created_at DESC').all(customerId) as ProposalRow[]).map(toProposal),
      save: (p: Proposal): void => {
        db.prepare(
          `UPDATE proposals SET status = ?, confirmed_at = ?, executed_at = ?, failure_reason = ? WHERE id = ?`,
        ).run(p.status, p.confirmedAt, p.executedAt, p.failureReason, p.id);
      },
    },

    audit: {
      append: (e: Omit<AuditEntry, 'id'>): void => {
        db.prepare(
          'INSERT INTO audit (ts, customer_id, actor_type, actor_id, event, proposal_id, card_id, details_json) VALUES (?,?,?,?,?,?,?,?)',
        ).run(e.ts, e.customerId, e.actorType, e.actorId, e.event, e.proposalId, e.cardId, JSON.stringify(e.details));
      },
      byCustomer: (customerId: string): AuditEntry[] =>
        (db.prepare('SELECT * FROM audit WHERE customer_id = ? ORDER BY id ASC').all(customerId) as AuditRow[]).map(toAudit),
    },

    oauth: {
      clients: {
        get: (clientId: string): OAuthClientRecord | null => {
          const r = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as OAuthClientRow | undefined;
          return r ? toOAuthClient(r) : null;
        },
        save: (c: OAuthClientRecord): void => {
          db.prepare(
            `INSERT INTO oauth_clients (client_id, client_secret, client_secret_expires_at, client_name, redirect_uris, created_at)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(client_id) DO UPDATE SET
               client_secret = excluded.client_secret,
               client_secret_expires_at = excluded.client_secret_expires_at,
               client_name = excluded.client_name,
               redirect_uris = excluded.redirect_uris`,
          ).run(c.clientId, c.clientSecret, c.clientSecretExpiresAt, c.clientName, JSON.stringify(c.redirectUris), c.createdAt);
        },
      },

      codes: {
        save: (c: OAuthCodeRecord): void => {
          db.prepare(
            `INSERT INTO oauth_codes (code, client_id, customer_id, redirect_uri, code_challenge,
               code_challenge_method, scopes, expires_at, used)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          ).run(
            c.code, c.clientId, c.customerId, c.redirectUri, c.codeChallenge,
            c.codeChallengeMethod, JSON.stringify(c.scopes), c.expiresAt, c.used ? 1 : 0,
          );
        },
        get: (code: string): OAuthCodeRecord | null => {
          const r = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code) as OAuthCodeRow | undefined;
          return r ? toOAuthCode(r) : null;
        },
        // Atómico: marca el código como usado y devuelve la fila en la misma sentencia (RETURNING),
        // o null si ya estaba usado o había caducado. Evita el doble canje por una condición de carrera.
        consume: (code: string, now: number): OAuthCodeRecord | null => {
          const r = db.prepare(
            'UPDATE oauth_codes SET used = 1 WHERE code = ? AND used = 0 AND expires_at > ? RETURNING *',
          ).get(code, now) as OAuthCodeRow | undefined;
          return r ? toOAuthCode(r) : null;
        },
      },

      tokens: {
        save: (t: OAuthTokenRecord): void => {
          db.prepare(
            `INSERT INTO oauth_tokens (token_hash, type, client_id, customer_id, scopes, expires_at, revoked, linked_token_hash)
             VALUES (?,?,?,?,?,?,?,?)`,
          ).run(
            t.tokenHash, t.type, t.clientId, t.customerId, JSON.stringify(t.scopes), t.expiresAt,
            t.revoked ? 1 : 0, t.linkedTokenHash,
          );
        },
        getByHash: (tokenHash: string): OAuthTokenRecord | null => {
          const r = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(tokenHash) as OAuthTokenRow | undefined;
          return r ? toOAuthToken(r) : null;
        },
        revoke: (tokenHash: string): void => {
          db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
        },
      },

      authRequests: {
        save: (r: OAuthAuthRequestRecord): void => {
          db.prepare(
            `INSERT INTO oauth_authorization_requests
               (request_id, client_id, redirect_uri, code_challenge, scopes, state, csrf_token, expires_at, used)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          ).run(
            r.requestId, r.clientId, r.redirectUri, r.codeChallenge, JSON.stringify(r.scopes),
            r.state, r.csrfToken, r.expiresAt, r.used ? 1 : 0,
          );
        },
        get: (requestId: string): OAuthAuthRequestRecord | null => {
          const r = db.prepare('SELECT * FROM oauth_authorization_requests WHERE request_id = ?').get(requestId) as
            | OAuthAuthRequestRow
            | undefined;
          return r ? toOAuthAuthRequest(r) : null;
        },
        // Atómico, igual que codes.consume: marca la petición como usada y la devuelve, o null si
        // ya estaba usada o había caducado. Es lo que impide reproducir el POST de consentimiento.
        consume: (requestId: string, now: number): OAuthAuthRequestRecord | null => {
          const r = db.prepare(
            'UPDATE oauth_authorization_requests SET used = 1 WHERE request_id = ? AND used = 0 AND expires_at > ? RETURNING *',
          ).get(requestId, now) as OAuthAuthRequestRow | undefined;
          return r ? toOAuthAuthRequest(r) : null;
        },
      },
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

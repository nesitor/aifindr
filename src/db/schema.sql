CREATE TABLE IF NOT EXISTS customers (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  last4       TEXT NOT NULL,
  brand       TEXT NOT NULL,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL,
  is_flaky    INTEGER NOT NULL DEFAULT 0
);

-- `agent_sessions` (tarea OAuth-B, ver docs/superpowers/specs/2026-09-08-mcp-card-block-gateway-design.md
-- §18): eliminada. La identidad del canal MCP ya no la crea este servidor con un token propio —
-- la establece OAuth (`oauth_tokens` más abajo), y lo que antes era el id de una fila aquí es
-- ahora `session_key`: el hash del access token OAuth (`hashToken`, calculado en
-- `verifyAccessToken`, `src/oauth/provider.ts`). Sin FK a propósito: no hay una tabla de sesiones
-- que referenciar, y un access token revocado o caducado deja de pasar `requireBearerAuth` mucho
-- antes de llegar aquí — no hace falta reforzarlo también en el esquema.
CREATE TABLE IF NOT EXISTS card_refs (
  session_key TEXT NOT NULL,
  ref         TEXT NOT NULL,
  card_id     TEXT NOT NULL REFERENCES cards(id),
  PRIMARY KEY (session_key, ref)
);

CREATE TABLE IF NOT EXISTS proposals (
  id              TEXT PRIMARY KEY,
  -- Tarea OAuth-B: ya no el id de una fila en `agent_sessions` — el `session_key` (hash del
  -- access token OAuth) que creó esta propuesta. Ver el comentario sobre `card_refs` más arriba.
  session_id      TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  card_id         TEXT NOT NULL,
  action          TEXT NOT NULL,
  reason          TEXT NOT NULL,
  note            TEXT,
  status          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  executed_at     INTEGER,
  failure_reason  TEXT
);

-- OAuth 2.1 para el canal MCP (ver docs/superpowers/specs/2026-09-08-mcp-card-block-gateway-design.md §18).
-- Los tokens se guardan siempre hasheados (hashToken de src/domain/refs.ts), nunca en claro. Los
-- códigos de autorización son de un solo uso (columna `used`).
--
-- `oauth_clients.client_secret` es la única excepción deliberada a "todo secreto se guarda
-- hasheado": el middleware `authenticateClient` del SDK de MCP (usado internamente por /token y
-- /revoke, sin ningún punto de extensión) compara el secreto que envía el cliente contra
-- `client.client_secret` **en claro**, tal cual lo devuelve `clientsStore.getClient()`. Un hash no
-- sirve ahí — no hay forma de deshacerlo para la comparación. Se guarda recuperable a propósito,
-- NULL para clientes públicos (`token_endpoint_auth_method: 'none'`, el caso normal para un
-- cliente MCP con PKCE obligatorio). Alcance: base de datos local de demostración, no un almacén
-- de secretos multi-tenant en producción.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                 TEXT PRIMARY KEY,
  client_secret             TEXT,
  -- Epoch en SEGUNDOS (no milisegundos, excepción deliberada): es el valor que ya calcula
  -- `handlers/register.js` del SDK y que su propio `authenticateClient` compara contra
  -- `Math.floor(Date.now() / 1000)`. Se persiste y se devuelve tal cual desde `toClientInfo` para
  -- que esa comprobación de caducidad (I3, fix round 2) se ejecute de verdad.
  client_secret_expires_at  INTEGER,
  client_name               TEXT,
  redirect_uris             TEXT NOT NULL,
  created_at                INTEGER NOT NULL
);

-- Petición de autorización pendiente (fix round 2): `authorize()` la crea y redirige a
-- /oauth/consent?request_id=<esto>, en vez de poner client_id/redirect_uri/code_challenge/scopes
-- en la URL o en un formulario. Sin esto, cualquiera puede llamar a POST /oauth/consent
-- directamente con su propio code_challenge y un customer_id ajeno, sin pasar por /authorize ni
-- por sesión alguna — el CRITICAL de la ronda 2. De un solo uso (columna `used`), caducidad corta,
-- y con su propio token CSRF (`csrf_token`) para que el formulario no sea reproducible desde fuera.
CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  request_id     TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  state          TEXT,
  csrf_token     TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id),
  customer_id           TEXT NOT NULL REFERENCES customers(id),
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scopes                TEXT NOT NULL,
  expires_at            INTEGER NOT NULL,
  used                  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash        TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id),
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  scopes            TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,
  revoked           INTEGER NOT NULL DEFAULT 0,
  -- Fix round 2 (I2): en un token de tipo 'access', el hash del refresh token emitido junto a él
  -- (o con el que se emitió, si vino de un exchangeRefreshToken). Revocar este access token revoca
  -- en cascada el refresh enlazado, para que "revocar el access y luego usar su refresh" no siga
  -- produciendo un access token nuevo.
  linked_token_hash TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  customer_id  TEXT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  event        TEXT NOT NULL,
  proposal_id  TEXT,
  card_id      TEXT,
  details_json TEXT NOT NULL
);

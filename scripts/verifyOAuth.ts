/**
 * Verificación de punta a punta del gateway: descubrimiento OAuth, registro dinámico de cliente,
 * PKCE, login, consentimiento, canje del código y llamadas MCP reales con el access token.
 *
 * No necesita navegador ni AI Findr: este script hace de cliente MCP. Sirve para comprobar que el
 * gateway funciona antes de culpar a nadie más, y deja constancia de que el aislamiento entre
 * clientes se sostiene con tokens OAuth de verdad, no sólo en los tests unitarios.
 *
 *   npm run verify                       # contra http://localhost:3000
 *   npm run verify -- https://tu.tunel   # contra el túnel público
 */
import { createHash, randomBytes } from 'node:crypto';

const BASE = (process.argv[2] ?? process.env.VERIFY_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const OFF = '\u001b[0m';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Bote de cookies mínimo: el consentimiento exige la cookie de sesión firmada. */
class Jar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      this.cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

// El plan gratuito de ngrok devuelve su página de aviso ante un User-Agent de navegador; esta
// cabecera la salta. Es inocua contra cualquier otro servidor.
const HEADERS = { 'ngrok-skip-browser-warning': '1' };

function base64url(b: Buffer): string {
  return b.toString('base64url');
}

function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

async function jsonRpc(token: string | null, body: unknown): Promise<Response> {
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** El transporte Streamable HTTP puede responder SSE; se extrae el primer `data:` si es el caso. */
async function rpcResult(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  const payload = dataLine ? dataLine.slice(5).trim() : text;
  return (JSON.parse(payload) as { result?: Record<string, unknown> }).result ?? {};
}

function firstText(result: Record<string, unknown>): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

/** Recorre el flujo de autorización entero para un cliente de banca y devuelve su access token. */
async function authorizeAs(customerId: string, label: string): Promise<string> {
  const redirectUri = 'http://localhost:9999/callback';

  const reg = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: `verify-script (${label})`,
      token_endpoint_auth_method: 'none',
    }),
  });
  check(reg.status === 201, `[${label}] registro dinámico de cliente`, `HTTP ${reg.status}`);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };

  const { verifier, challenge } = pkce();
  const authUrl = new URL(`${BASE}/authorize`);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    scope: 'cards:propose',
    state: 'xyz',
  }).toString();

  const jar = new Jar();
  const auth = await fetch(authUrl, { headers: HEADERS, redirect: 'manual' });
  const consentUrl = new URL(auth.headers.get('location') ?? '/', BASE);
  check(
    auth.status === 302 && consentUrl.pathname === '/oauth/consent',
    `[${label}] /authorize redirige al consentimiento con un request_id opaco`,
  );
  const requestId = consentUrl.searchParams.get('request_id') ?? '';

  // Sin sesión, el consentimiento manda a la pantalla de login: la identidad NUNCA sale del cuerpo.
  const noSession = await fetch(consentUrl, { headers: HEADERS, redirect: 'manual' });
  check(
    noSession.status === 302 && (noSession.headers.get('location') ?? '').includes('/oauth/consent/login'),
    `[${label}] sin sesión, el consentimiento exige login`,
  );

  const login = await fetch(`${BASE}/oauth/consent/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId, customer_id: customerId }).toString(),
  });
  jar.absorb(login);
  check(login.status === 302, `[${label}] el login simulado establece la sesión`);

  const page = await fetch(consentUrl, { headers: { ...HEADERS, Cookie: jar.header() } });
  const html = await page.text();
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
  check(csrf.length > 0, `[${label}] la pantalla de consentimiento trae token CSRF`);

  const consent = await fetch(`${BASE}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ request_id: requestId, csrf_token: csrf }).toString(),
  });
  const back = new URL(consent.headers.get('location') ?? 'http://invalid/');
  const code = back.searchParams.get('code') ?? '';
  check(consent.status === 302 && code.length > 0, `[${label}] el consentimiento emite el código`);

  const tok = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const tokens = (await tok.json()) as { access_token?: string };
  check(
    tok.status === 200 && !!tokens.access_token,
    `[${label}] canje del código por access token`,
    `HTTP ${tok.status}`,
  );

  // El código es de un solo uso: reintentarlo (aquí, además, con otro verifier) debe fallar.
  const replay = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: base64url(randomBytes(32)),
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString(),
  });
  check(replay.status >= 400, `[${label}] el código no se puede reutilizar`, `HTTP ${replay.status}`);

  return tokens.access_token ?? '';
}

async function main(): Promise<void> {
  console.log(`\nVerificando ${BASE}\n`);

  console.log('Descubrimiento');
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`, { headers: HEADERS });
  const prmBody = (await prm.json().catch(() => ({}))) as { resource?: string };
  check(
    prm.status === 200 && prmBody.resource === `${BASE}/mcp`,
    'el metadata del recurso protegido apunta a /mcp',
    prmBody.resource ?? `HTTP ${prm.status}`,
  );

  const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`, { headers: HEADERS });
  const asBody = (await asm.json().catch(() => ({}))) as {
    registration_endpoint?: string;
    code_challenge_methods_supported?: string[];
  };
  check(asm.status === 200 && !!asBody.registration_endpoint, 'se anuncia el registro dinámico de clientes');
  check(asBody.code_challenge_methods_supported?.includes('S256') === true, 'se anuncia PKCE con S256');

  const anon = await jsonRpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  check(anon.status === 401, '/mcp sin token responde 401', `HTTP ${anon.status}`);
  check(
    (anon.headers.get('www-authenticate') ?? '').includes('resource_metadata'),
    'el 401 indica dónde está el metadata del recurso',
  );

  console.log('\nFlujo de autorización');
  const anaToken = await authorizeAs('cus_ana', 'ana');
  const luisToken = await authorizeAs('cus_luis', 'luis');

  console.log('\nSuperficie MCP');
  const list = await rpcResult(await jsonRpc(anaToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const tools = (list.tools ?? []) as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  const names = tools.map((t) => t.name);
  check(names.length === 3, 'se exponen exactamente tres tools', names.join(', '));
  check(
    !names.some((n) => /confirm|execute|unblock|reset/i.test(n)),
    'ninguna tool confirma, ejecuta ni desbloquea (C2)',
  );
  const identityArgs = tools
    .flatMap((t) => Object.keys(t.inputSchema?.properties ?? {}))
    .filter((k) => /session|token|customer|user|identity/i.test(k));
  check(
    identityArgs.length === 0,
    'ninguna tool recibe identidad como argumento',
    identityArgs.join(', ') || 'ninguno',
  );

  const anaCards = await rpcResult(
    await jsonRpc(anaToken, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_debit_cards', arguments: {} },
    }),
  );
  const anaText = firstText(anaCards);
  const active = (JSON.parse(anaText) as { cards: Array<{ cardRef: string; status: string }> }).cards.find(
    (c) => c.status === 'ACTIVE',
  );
  check(!!active && active.cardRef.startsWith('cref_'), 'list_debit_cards devuelve referencias opacas', active?.cardRef ?? '');
  check(!/\d{13,}/.test(anaText), 'no se expone ningún número de tarjeta completo');
  const anaRef = active?.cardRef ?? '';

  console.log('\nAislamiento entre clientes (C1)');
  const cross = await rpcResult(
    await jsonRpc(luisToken, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'propose_card_block', arguments: { card_ref: anaRef, reason: 'STOLEN' } },
    }),
  );
  const crossText = firstText(cross);
  check(
    /does not exist in this session/i.test(crossText),
    'el card_ref de un cliente no sirve con el token de otro',
    crossText.slice(0, 60),
  );

  const own = await rpcResult(
    await jsonRpc(anaToken, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'propose_card_block', arguments: { card_ref: anaRef, reason: 'STOLEN' } },
    }),
  );
  const ownBody = JSON.parse(firstText(own)) as { status?: string; confirmationUrl?: string };
  check(ownBody.status === 'PROPOSED', 'el titular sí puede proponer, y queda en PROPOSED', String(ownBody.status));
  check(!!ownBody.confirmationUrl, 'la propuesta remite a la confirmación humana', ownBody.confirmationUrl ?? '');

  console.log(
    failures === 0
      ? `\n${GREEN}Todo correcto.${OFF} El gateway funciona de punta a punta con OAuth.\n`
      : `\n${RED}${failures} comprobación(es) fallaron.${OFF}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();

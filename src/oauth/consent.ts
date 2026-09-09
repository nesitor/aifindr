import { Router, type NextFunction, type Request, type Response } from 'express';
import express from 'express';
import { SESSION_COOKIE } from '../api/auth.js';
import type { Repositories } from '../db/repositories.js';
import type { Customer } from '../domain/types.js';
import { newId } from '../domain/refs.js';

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .option { display: block; padding: 8px 0; }
  .muted { color: #666; font-size: 0.85em; }
  button { background: #111; color: #fff; border: none; border-radius: 6px; padding: 10px 16px; font-size: 1rem; cursor: pointer; }
  code { background: #f2f2f2; padding: 2px 4px; border-radius: 4px; }
`;

function renderConsentPage(p: {
  clientName: string; scope: string; customerId: string; customerName: string;
  requestId: string; csrfToken: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Authorize access</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>${escapeHtml(p.clientName)} is requesting access</h1>
  <p>This application is requesting permission to: <code>${escapeHtml(p.scope)}</code></p>
  <p>You are about to authorize it as <strong>${escapeHtml(p.customerName)}</strong>
     <span class="muted">(${escapeHtml(p.customerId)})</span>.</p>
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="request_id" value="${escapeHtml(p.requestId)}" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(p.csrfToken)}" />
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

function renderLoginPage(p: { requestId: string; customers: readonly Customer[] }): string {
  const customerOptions = p.customers.map(
    (c, i) =>
      `<label class="option">
        <input type="radio" name="customer_id" value="${escapeHtml(c.id)}" ${i === 0 ? 'checked' : ''} />
        ${escapeHtml(c.name)} <span class="muted">(${escapeHtml(c.id)})</span>
      </label>`,
  ).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Sign in</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>Sign in to continue</h1>
  <p>Choose which banking customer to continue as:</p>
  <p class="muted">Simulated sign-in: no passwords, no real identity. This is the single point
     where identity is established; everything downstream derives from it.</p>
  <form method="POST" action="/oauth/consent/login">
    <div class="card">${customerOptions}</div>
    <input type="hidden" name="request_id" value="${escapeHtml(p.requestId)}" />
    <button type="submit">Continue</button>
  </form>
</body>
</html>`;
}

function noStoreHeaders(_req: Request, res: Response, next: NextFunction): void {
  // Fix round 2: cabeceras anti-clickjacking en todo el router de consentimiento (incluida la
  // pantalla de login), no sólo en /oauth/consent.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export function createConsentRouter(repos: Repositories, now: () => number = Date.now): Router {
  const router = Router();

  // Los titulares salen de la tabla `customers`, no de una lista escrita en el código: añadir uno
  // a la base de datos basta para que aparezca aquí, en POST /api/login y en la SPA. Se consulta
  // en cada petición y no se cachea, para que un alta no exija reiniciar el servidor.
  const knownCustomer = (id: string): Customer | null => (id ? repos.customers.byId(id) : null);
  router.use(express.urlencoded({ extended: false }));
  router.use(noStoreHeaders);

  function sessionCustomerId(req: Request): string | undefined {
    return req.signedCookies?.[SESSION_COOKIE] as string | undefined;
  }

  function setSessionCookie(res: Response, customerId: string): void {
    // Mismas opciones que POST /api/login (src/api/routes.ts): es la misma cookie de sesión web.
    res.cookie(SESSION_COOKIE, customerId, { httpOnly: true, signed: true, sameSite: 'lax' });
  }

  // GET /oauth/consent?request_id=... — la petición vive en el servidor (fix round 2): esto NO
  // recibe ni confía en client_id/redirect_uri/code_challenge/scope, sólo el identificador opaco
  // que generó `authorize()`. Sin sesión web, lleva a la pantalla de login conservando request_id.
  router.get('/', (req, res) => {
    const requestId = String(req.query.request_id ?? '');
    if (!requestId) {
      res.status(400).send('Missing request_id.');
      return;
    }
    const pending = repos.oauth.authRequests.get(requestId);
    if (!pending || pending.used || pending.expiresAt <= now()) {
      res.status(400).send('Invalid, expired, or already used authorization request.');
      return;
    }

    const customer = knownCustomer(sessionCustomerId(req) ?? '');
    if (!customer) {
      res.redirect(302, `/oauth/consent/login?request_id=${encodeURIComponent(requestId)}`);
      return;
    }

    const client = repos.oauth.clients.get(pending.clientId);
    if (!client) {
      res.status(400).send('Unknown OAuth client.');
      return;
    }

    res.status(200).type('html').send(
      renderConsentPage({
        clientName: client.clientName ?? client.clientId,
        scope: pending.scopes.join(' '),
        customerId: customer.id,
        customerName: customer.name,
        requestId: pending.requestId,
        csrfToken: pending.csrfToken,
      }),
    );
  });

  // GET /oauth/consent/login — pantalla de login simulado, propia de este flujo (no toca
  // /api/login ni la cookie de la SPA salvo por compartir el mismo nombre de cookie de sesión).
  router.get('/login', (req, res) => {
    const requestId = String(req.query.request_id ?? '');
    if (!requestId) {
      res.status(400).send('Missing request_id.');
      return;
    }
    const pending = repos.oauth.authRequests.get(requestId);
    if (!pending || pending.used || pending.expiresAt <= now()) {
      res.status(400).send('Invalid, expired, or already used authorization request.');
      return;
    }
    res.status(200).type('html').send(renderLoginPage({ requestId, customers: repos.customers.list() }));
  });

  router.post('/login', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const requestId = String(body.request_id ?? '');
    const customerId = String(body.customer_id ?? '');

    const pending = repos.oauth.authRequests.get(requestId);
    if (!pending || pending.used || pending.expiresAt <= now()) {
      res.status(400).send('Invalid, expired, or already used authorization request.');
      return;
    }
    if (!knownCustomer(customerId)) {
      res.status(400).send('Unrecognized banking customer.');
      return;
    }

    setSessionCookie(res, customerId);
    res.redirect(302, `/oauth/consent?request_id=${encodeURIComponent(requestId)}`);
  });

  // POST /oauth/consent — exige sesión web. El customer_id sale SIEMPRE de la cookie firmada,
  // nunca del cuerpo (fix round 2, CRITICAL): antes se leía de un campo de formulario, lo que
  // permitía a cualquiera con un client_id propio llamar aquí directamente, sin navegador, sin
  // cookie y sin pasar por /authorize, con `customer_id` de otro cliente en el cuerpo.
  router.post('/', (req, res) => {
    const customer = knownCustomer(sessionCustomerId(req) ?? '');
    if (!customer) {
      res.status(401).send('Not authenticated.');
      return;
    }
    const customerId = customer.id;

    const body = req.body as Record<string, unknown>;
    const requestId = String(body.request_id ?? '');
    const csrfToken = String(body.csrf_token ?? '');

    const pending = repos.oauth.authRequests.get(requestId);
    if (!pending || pending.used || pending.expiresAt <= now()) {
      res.status(400).send('Invalid, expired, or already used authorization request.');
      return;
    }
    // Fix round 2: token CSRF de un solo uso, ligado a la petición pendiente. Sin él (o con uno
    // que no coincide) no se emite ningún código, aunque haya sesión válida.
    if (!csrfToken || csrfToken !== pending.csrfToken) {
      res.status(403).send('Missing or invalid CSRF token.');
      return;
    }

    // Consumo atómico: si entre el peek de arriba y aquí alguien más ya la consumió (o caducó
    // justo ahora), `consume` devuelve null y no se emite nada. Cierra la ventana de reuso.
    const consumed = repos.oauth.authRequests.consume(requestId, now());
    if (!consumed) {
      res.status(400).send('Invalid, expired, or already used authorization request.');
      return;
    }

    const client = repos.oauth.clients.get(consumed.clientId);
    if (!client) {
      res.status(400).send('Unknown OAuth client.');
      return;
    }
    // Redundante con la validación que ya hizo `authorize()`/el SDK al crear la petición, pero se
    // repite aquí por el mismo motivo que en la ronda anterior: no cuesta nada y es la última
    // barrera antes de emitir un código.
    if (!client.redirectUris.includes(consumed.redirectUri)) {
      res.status(400).send('redirect_uri is not registered for this client. Request rejected.');
      return;
    }

    const code = newId('acode');
    repos.oauth.codes.save({
      code, clientId: client.clientId, customerId, redirectUri: consumed.redirectUri,
      codeChallenge: consumed.codeChallenge, codeChallengeMethod: 'S256',
      scopes: consumed.scopes, expiresAt: now() + AUTHORIZATION_CODE_TTL_MS, used: false,
    });

    const redirectUrl = new URL(consumed.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (consumed.state) redirectUrl.searchParams.set('state', consumed.state);
    res.redirect(302, redirectUrl.href);
  });

  return router;
}

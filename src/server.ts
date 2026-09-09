import express from 'express';
import cookieParser from 'cookie-parser';
import { resolve } from 'node:path';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createApiRouter } from './api/routes.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { createRepositories, type Repositories } from './db/repositories.js';
import { seedDatabase } from './db/seed.js';
import { createMcpRouter } from './mcp/server.js';
import { createOAuthProvider, MCP_SCOPE } from './oauth/provider.js';
import { createConsentRouter } from './oauth/consent.js';
import { createCardBlockService, type CardBlockService } from './services/cardBlockService.js';
import * as ngrok from "@ngrok/ngrok";

/**
 * Prefijos servidos por el gateway. Se listan explícitamente porque el fallback de la SPA es lo
 * último que se monta y, sin esta lista, se tragaría cualquier ruta de servidor no reconocida.
 */
const SERVER_PREFIXES = ['/api', '/mcp', '/.well-known', '/authorize', '/token', '/register', '/revoke', '/oauth'];

export interface AppDeps {
  service: CardBlockService;
  repos: Repositories;
  sessionCookieSecret: string;
  publicBaseUrl: string;
  staticDir: string | null;
  demoMode?: boolean;
  /** Saltos de proxy de confianza. Ver `resolveTrustProxy` en src/config.ts. */
  trustProxy?: number;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  // Sólo se declara si de verdad hay un proxy delante. Ponerlo a 0 explícitamente sería peor que
  // no ponerlo: silenciaría el aviso de express-rate-limit sin arreglar nada, porque el limitador
  // seguiría metiendo a todo el mundo en el mismo cubo (la IP del proxy). Sin proxy, Express se
  // queda en su valor por defecto (`false`) y descarta cualquier X-Forwarded-For que le llegue.
  if (deps.trustProxy && deps.trustProxy > 0) app.set('trust proxy', deps.trustProxy);
  app.use(express.json());
  app.use(cookieParser(deps.sessionCookieSecret));

  const provider = createOAuthProvider({ repos: deps.repos, publicBaseUrl: deps.publicBaseUrl });

  // El recurso protegido es /mcp, NO la raíz. Sin declararlo, el SDK cae en su respaldo por
  // compatibilidad (el issuer) y publica el metadata en /.well-known/oauth-protected-resource
  // anunciando `resource` = raíz del túnel. Un cliente MCP que siga RFC 9728 pide la variante con
  // el path del recurso (/.well-known/oauth-protected-resource/mcp), que entonces no existe.
  const resourceServerUrl = new URL('/mcp', deps.publicBaseUrl);
  // mcpAuthRouter debe montarse en la raíz de la aplicación: define rutas absolutas como
  // /authorize, /token, /register, /revoke y /.well-known/oauth-authorization-server.
  app.use(mcpAuthRouter({
    provider, issuerUrl: new URL(deps.publicBaseUrl), resourceServerUrl, scopesSupported: [MCP_SCOPE],
  }));
  app.use('/oauth/consent', createConsentRouter(deps.repos));

  app.use('/api', createApiRouter(deps.service, deps.repos, deps.demoMode ?? false));
  // El 401 de /mcp lleva ahora `resource_metadata` en WWW-Authenticate: es como la spec de MCP
  // espera que un cliente descubra dónde autenticarse, sin tener que adivinar rutas.
  app.use('/mcp', createMcpRouter(deps.service, provider, getOAuthProtectedResourceMetadataUrl(resourceServerUrl)));
  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
    const indexHtml = resolve(deps.staticDir, 'index.html');
    app.use((req, res, next) => {
      // Ninguna ruta del servidor puede caer en el fallback de la SPA. Devolver index.html con un
      // 200 ante un descubrimiento OAuth fallido es peor que un 404: el cliente recibe HTML donde
      // espera JSON y no puede distinguir "esta ruta no existe" de "aquí tienes una app web".
      const isServerPath = SERVER_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
      // Y la SPA sólo se sirve a quien viene a navegar: una petición que no es GET, o que no
      // acepta HTML, recibe el 404 de Express en vez de una página.
      if (isServerPath || req.method !== 'GET' || !req.accepts('html')) {
        next();
        return;
      }
      res.sendFile(indexHtml);
    });
  }
  return app;
}

/**
 * Un host de bucle local nunca se puede publicar por un túnel. Se comprueba el nombre, no la URL
 * por defecto: comparar contra DEFAULT_PUBLIC_BASE_URL sólo cubría el puerto 3000, así que
 * arrancar en cualquier otro puerto local intentaba reservar un dominio como "localhost:3100".
 */
export function isLoopbackHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname);
}

async function forwardToApp(port: number, domain: string) {
  if (isLoopbackHost(domain)) {
    console.log(`No public domain configured (${domain}); skipping ngrok tunnel.`);
    return;
  }
  try {
    const forwarder = await ngrok.forward({
      addr: `localhost:${port}`,
      authtoken_from_env: true,
      domain,
    });
    console.log(`Available at: ${forwarder.url()}`);
  } catch (err) {
    // Un fallo del túnel no debe tumbar el gateway: sin captura, este rechazo ocurre
    // dentro del callback async de listen() y termina el proceso.
    console.error(`Could not open the ngrok tunnel (${(err as Error).message}). The server is still listening on :${port}.`);
  }
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const repos = createRepositories(db);
  seedDatabase(repos, db);
  const service = createCardBlockService({
    repos, now: () => Date.now(), ttlSeconds: config.proposalTtlSeconds, publicBaseUrl: config.publicBaseUrl,
  });
  const app = createApp({
    service, repos, sessionCookieSecret: config.sessionCookieSecret,
    publicBaseUrl: config.publicBaseUrl,
    staticDir: 'web/dist', demoMode: config.demoMode, trustProxy: config.trustProxy,
  });
  app.listen(config.port, async () => {
    console.log(`Gateway listening on :${config.port}`);
    const url = new URL(config.publicBaseUrl);
    await forwardToApp(config.port, url.host);
  });
}

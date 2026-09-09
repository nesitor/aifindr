import { Router, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { CardBlockService } from '../services/cardBlockService.js';
import { MCP_SCOPE } from '../oauth/provider.js';
import { buildToolDefs, type ToolIdentity } from './tools.js';

/**
 * Deriva la identidad de la llamada a partir del `AuthInfo` que el SDK cuelga del contexto de cada
 * tool call (`extra.authInfo`, tipo `RequestHandlerExtra` — ver
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts`), ya verificado por
 * `requireBearerAuth` + `verifyAccessToken` (`src/oauth/provider.ts`) antes de llegar aquí.
 *
 * Es la propiedad central de la tarea OAuth-B (spec §18): si falta `authInfo`, o si le falta
 * `customerId` o `sessionKey`, esta función lanza — ANTES de que el handler de ninguna tool se
 * ejecute. El SDK captura esa excepción (`server/mcp.js`, `CallToolRequestSchema`) y la convierte
 * en un `CallToolResult` con `isError: true`; nunca llega a invocar `def.handler`, así que nunca
 * hay una operación con identidad ausente o por defecto.
 */
export function resolveIdentity(authInfo: AuthInfo | undefined): ToolIdentity {
  const customerId = authInfo?.extra?.customerId;
  if (typeof customerId !== 'string' || customerId.length === 0) {
    throw new Error('Not authenticated: a valid OAuth access token carrying a customer identity is required.');
  }
  const sessionKey = authInfo?.extra?.sessionKey;
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new Error('Not authenticated: the access token carries no session key.');
  }
  return { customerId, sessionKey };
}

export function buildMcpServer(service: CardBlockService): McpServer {
  const server = new McpServer({ name: 'card-block-gateway', version: '1.0.0' });

  for (const def of buildToolDefs(service)) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      async (args: Record<string, unknown>, extra) => ({
        content: [{ type: 'text' as const, text: await def.handler(args, resolveIdentity(extra.authInfo)) }],
      }),
    );
  }
  return server;
}

export function createMcpRouter(
  service: CardBlockService,
  verifier: OAuthTokenVerifier,
  resourceMetadataUrl?: string,
): Router {
  const router = Router();

  router.use(requireBearerAuth({ verifier, requiredScopes: [MCP_SCOPE], resourceMetadataUrl }));

  router.post('/', async (req: Request, res: Response) => {
    const server = buildMcpServer(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}

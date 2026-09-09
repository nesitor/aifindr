import { createHash, randomBytes } from 'node:crypto';
import { CARD_BLOCK_ACTION } from './types.js';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('hex')}`;
}

export function newRef(): string {
  return newId('cref');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * `sessionKey` es el hash del access token OAuth que identifica la conexión (ver
 * `src/oauth/provider.ts`, `verifyAccessToken`), no un id de fila en una tabla de sesiones: ya no
 * existe tal tabla (ver docs/superpowers/specs/2026-09-08-mcp-card-block-gateway-design.md §18).
 */
export function idempotencyKey(sessionKey: string, cardId: string, reason: string): string {
  return createHash('sha256').update(`${sessionKey}|${cardId}|${CARD_BLOCK_ACTION}|${reason}`).digest('hex');
}

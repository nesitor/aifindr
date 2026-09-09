import { describe, expect, it } from 'vitest';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { resolveIdentity } from '../../src/mcp/server.js';

/**
 * Test adversarial obligatorio (tarea OAuth-B): una llamada a una tool sin `authInfo` verificado,
 * o con un `authInfo` al que le falta `customerId`/`sessionKey`, debe FALLAR — nunca continuar con
 * una identidad ausente o por defecto. `resolveIdentity` es lo único entre el `extra.authInfo` que
 * entrega el SDK y el handler de cualquier tool (ver `src/mcp/server.ts`, `buildMcpServer`): si
 * lanza, el SDK convierte esa excepción en un `CallToolResult` con `isError: true` ANTES de invocar
 * ningún handler (`server/mcp.js`, `CallToolRequestSchema`) — nunca en una operación que se
 * ejecuta.
 */
describe('resolveIdentity — la identidad viaja por el transporte, nunca por el contenido', () => {
  it('lanza si no hay authInfo en absoluto', () => {
    expect(() => resolveIdentity(undefined)).toThrow();
  });

  it('lanza si authInfo no lleva "extra"', () => {
    const authInfo = { token: 't', clientId: 'c', scopes: [] } as AuthInfo;
    expect(() => resolveIdentity(authInfo)).toThrow();
  });

  it('lanza si "extra" está vacío (sin customerId ni sessionKey)', () => {
    const authInfo = { token: 't', clientId: 'c', scopes: [], extra: {} } as AuthInfo;
    expect(() => resolveIdentity(authInfo)).toThrow();
  });

  it('lanza si falta customerId aunque sessionKey esté presente', () => {
    const authInfo = { token: 't', clientId: 'c', scopes: [], extra: { sessionKey: 'sk_1' } } as AuthInfo;
    expect(() => resolveIdentity(authInfo)).toThrow();
  });

  it('lanza si customerId es una cadena vacía (identidad por defecto, no ausencia)', () => {
    const authInfo = { token: 't', clientId: 'c', scopes: [], extra: { customerId: '', sessionKey: 'sk_1' } } as AuthInfo;
    expect(() => resolveIdentity(authInfo)).toThrow();
  });

  it('lanza si customerId no es una cadena (por ejemplo, un objeto o un número colado en extra)', () => {
    const authInfo = { token: 't', clientId: 'c', scopes: [], extra: { customerId: 123, sessionKey: 'sk_1' } } as unknown as AuthInfo;
    expect(() => resolveIdentity(authInfo)).toThrow();
  });

  it('lanza si falta sessionKey aunque customerId esté presente', () => {
    const authInfo = { token: 't', clientId: 'c', scopes: [], extra: { customerId: 'cus_ana' } } as AuthInfo;
    expect(() => resolveIdentity(authInfo)).toThrow();
  });

  it('lanza si sessionKey es una cadena vacía', () => {
    const authInfo = { token: 't', clientId: 'c', scopes: [], extra: { customerId: 'cus_ana', sessionKey: '' } } as AuthInfo;
    expect(() => resolveIdentity(authInfo)).toThrow();
  });

  it('devuelve exactamente {customerId, sessionKey} cuando authInfo está completo, y nada más de extra', () => {
    const authInfo = {
      token: 't', clientId: 'c', scopes: ['cards:propose'],
      extra: { customerId: 'cus_ana', sessionKey: 'sk_1', algoInesperado: 'no debería colarse' },
    } as AuthInfo;
    expect(resolveIdentity(authInfo)).toEqual({ customerId: 'cus_ana', sessionKey: 'sk_1' });
  });
});

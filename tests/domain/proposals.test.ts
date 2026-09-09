import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../src/domain/types.js';
import {
  assertConfirmable,
  beginExecution,
  completeExecution,
  confirm,
  effectiveStatus,
  failExecution,
  reject,
} from '../../src/domain/proposals.js';
import { DomainError } from '../../src/domain/errors.js';

const T0 = 1_000_000;

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop_1',
    sessionId: 'sess_1',
    customerId: 'cus_1',
    cardId: 'card_1',
    action: 'card.block',
    reason: 'STOLEN',
    note: null,
    status: 'PROPOSED',
    idempotencyKey: 'key_1',
    createdAt: T0,
    expiresAt: T0 + 300_000,
    confirmedAt: null,
    executedAt: null,
    failureReason: null,
    ...overrides,
  };
}

describe('effectiveStatus', () => {
  it('mantiene PROPOSED antes de la caducidad', () => {
    expect(effectiveStatus(proposal(), T0 + 1)).toBe('PROPOSED');
  });

  it('devuelve EXPIRED en cuanto se alcanza expiresAt, sin barrido previo', () => {
    expect(effectiveStatus(proposal(), T0 + 300_000)).toBe('EXPIRED');
  });

  it('no caduca estados ya resueltos', () => {
    const p = proposal({ status: 'EXECUTED', executedAt: T0 + 10 });
    expect(effectiveStatus(p, T0 + 999_999)).toBe('EXECUTED');
  });
});

describe('assertConfirmable', () => {
  it('acepta una propuesta viva', () => {
    expect(() => assertConfirmable(proposal(), T0 + 1)).not.toThrow();
  });

  it('rechaza una propuesta caducada', () => {
    try {
      assertConfirmable(proposal(), T0 + 300_000);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('PROPOSAL_EXPIRED');
    }
  });

  it('rechaza una propuesta ya rechazada', () => {
    try {
      assertConfirmable(proposal({ status: 'REJECTED' }), T0 + 1);
      throw new Error('debería haber lanzado');
    } catch (err) {
      expect((err as DomainError).code).toBe('PROPOSAL_NOT_PENDING');
    }
  });
});

describe('transiciones', () => {
  it('confirm marca CONFIRMED y sella confirmedAt', () => {
    const p = confirm(proposal(), T0 + 5);
    expect(p.status).toBe('CONFIRMED');
    expect(p.confirmedAt).toBe(T0 + 5);
  });

  it('reject marca REJECTED', () => {
    expect(reject(proposal(), T0 + 5).status).toBe('REJECTED');
  });

  it('la ejecución pasa por EXECUTING antes de EXECUTED', () => {
    const executing = beginExecution(confirm(proposal(), T0 + 5), T0 + 6);
    expect(executing.status).toBe('EXECUTING');
    const done = completeExecution(executing, T0 + 7);
    expect(done.status).toBe('EXECUTED');
    expect(done.executedAt).toBe(T0 + 7);
  });

  it('failExecution guarda el motivo', () => {
    const executing = beginExecution(confirm(proposal(), T0 + 5), T0 + 6);
    const failed = failExecution(executing, T0 + 7, 'issuer unavailable');
    expect(failed.status).toBe('FAILED');
    expect(failed.failureReason).toBe('issuer unavailable');
  });

  it('no se puede ejecutar una propuesta que no está CONFIRMED', () => {
    expect(() => beginExecution(proposal(), T0 + 6)).toThrow(DomainError);
  });

  it('no se puede completar una propuesta que no está EXECUTING', () => {
    expect(() => completeExecution(proposal(), T0 + 7)).toThrow(DomainError);
    expect(() => completeExecution(confirm(proposal(), T0 + 5), T0 + 7)).toThrow(DomainError);
  });

  it('no se puede fallar una propuesta que ya terminó', () => {
    const executing = beginExecution(confirm(proposal(), T0 + 5), T0 + 6);
    const done = completeExecution(executing, T0 + 7);
    expect(() => failExecution(done, T0 + 8, 'tarde')).toThrow(DomainError);
  });
});

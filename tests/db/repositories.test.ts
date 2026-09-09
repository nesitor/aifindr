import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';

function freshRepos() {
  const db = openDatabase(':memory:');
  const repos = createRepositories(db);
  seedDatabase(repos, db);
  return repos;
}

describe('repositorios', () => {
  it('las semillas crean tarjetas activas para el cliente demo', () => {
    const repos = freshRepos();
    const cards = repos.cards.byCustomer('cus_ana');
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards.some((c) => c.status === 'ACTIVE')).toBe(true);
  });

  it('las semillas incluyen una tarjeta flaky para demostrar FAILED', () => {
    const repos = freshRepos();
    const all = repos.cards.byCustomer('cus_ana');
    expect(all.some((c) => c.isFlaky)).toBe(true);
  });

  it('resuelve un card_ref sólo dentro de su sesión (sessionKey = hash del access token)', () => {
    const repos = freshRepos();
    repos.cardRefs.put('skey_a', 'cref_x', 'card_ana_1');

    expect(repos.cardRefs.resolve('skey_a', 'cref_x')).toBe('card_ana_1');
    expect(repos.cardRefs.resolve('skey_b', 'cref_x')).toBeNull();
  });

  it('el log de auditoría es append-only y conserva el orden', () => {
    const repos = freshRepos();
    repos.audit.append({ ts: 1, customerId: 'cus_ana', actorType: 'AGENT', actorId: 'sess_a', event: 'proposal.created', proposalId: 'p1', cardId: 'card_ana_1', details: { reason: 'STOLEN' } });
    repos.audit.append({ ts: 2, customerId: 'cus_ana', actorType: 'HUMAN', actorId: 'cus_ana', event: 'proposal.confirmed', proposalId: 'p1', cardId: 'card_ana_1', details: {} });
    repos.audit.append({ ts: 3, customerId: 'cus_ana', actorType: 'AGENT', actorId: 'sess_a', event: 'proposal.denied', proposalId: null, cardId: null, details: { code: 'NOT_FOUND' } });

    const rows = repos.audit.byCustomer('cus_ana');
    expect(rows.map((r) => r.event)).toEqual(['proposal.created', 'proposal.confirmed', 'proposal.denied']);
    expect(rows[0].details).toEqual({ reason: 'STOLEN' });
    expect('update' in repos.audit).toBe(false);
    expect('delete' in repos.audit).toBe(false);
  });

  it('la idempotencia sólo aplica a propuestas vivas', () => {
    const repos = freshRepos();
    repos.proposals.insert({
      id: 'p1', sessionId: 'skey_a', customerId: 'cus_ana', cardId: 'card_ana_1',
      action: 'card.block', reason: 'STOLEN', note: null, status: 'PROPOSED',
      idempotencyKey: 'k1', createdAt: 1, expiresAt: 300_001,
      confirmedAt: null, executedAt: null, failureReason: null,
    });

    expect(repos.proposals.byLiveIdempotencyKey('k1', 2)?.id).toBe('p1');
    expect(repos.proposals.byLiveIdempotencyKey('k1', 300_002)).toBeNull();
    expect(repos.proposals.byId('p1')?.reason).toBe('STOLEN');
  });
});

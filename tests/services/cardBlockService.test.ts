import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';
import { createCardBlockService, type Identity } from '../../src/services/cardBlockService.js';
import { DomainError } from '../../src/domain/errors.js';

let repos: Repositories;
let clock: number;
let service: ReturnType<typeof createCardBlockService>;

beforeEach(() => {
  const db = openDatabase(':memory:');
  repos = createRepositories(db);
  seedDatabase(repos, db);
  clock = 1_000_000;
  service = createCardBlockService({
    repos,
    now: () => clock,
    ttlSeconds: 300,
    publicBaseUrl: 'https://gateway.test',
    sleep: async () => {},
    executionDelayMs: 0,
  });
});

// Identidad ya resuelta por OAuth (ver src/mcp/server.ts): cada llamada simula un access token
// distinto para el mismo cliente, igual que antes `service.createAgentSession('cus_ana')` creaba
// una sesión de agente nueva en cada llamada.
let sessionSeq = 0;
function anaIdentity(): Identity {
  sessionSeq += 1;
  return { customerId: 'cus_ana', sessionKey: `skey_ana_${sessionSeq}` };
}
function luisIdentity(): Identity {
  sessionSeq += 1;
  return { customerId: 'cus_luis', sessionKey: `skey_luis_${sessionSeq}` };
}

function refFor(identity: Identity, last4: string) {
  const card = service.listCards(identity).find((c) => c.last4 === last4);
  if (!card) throw new Error(`sin tarjeta ${last4}`);
  return card.cardRef;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    return (err as DomainError).code;
  }
  throw new Error('se esperaba un DomainError');
}

describe('happy path', () => {
  it('proponer y confirmar bloquea la tarjeta y deja rastro ordenado', async () => {
    const identity = anaIdentity();
    const proposal = service.proposeBlock(identity, { cardRef: refFor(identity, '4471'), reason: 'STOLEN' });
    expect(proposal.status).toBe('PROPOSED');
    expect(proposal.confirmationUrl).toContain('https://gateway.test/proposals/');

    const result = await service.confirmProposal('cus_ana', proposal.proposalId);
    expect(result.status).toBe('EXECUTED');
    expect(repos.cards.byId('card_ana_1')?.status).toBe('BLOCKED');

    const events = repos.audit.byCustomer('cus_ana').map((e) => e.event);
    expect(events).toEqual([
      'proposal.created',
      'proposal.confirmed',
      'execution.started',
      'execution.succeeded',
    ]);
  });
});

describe('identidad ausente', () => {
  it('ninguna operación procede con customerId o sessionKey vacíos', () => {
    expect(codeOf(() => service.listCards({ customerId: '', sessionKey: 'sk' }))).toBe('FORBIDDEN');
    expect(codeOf(() => service.listCards({ customerId: 'cus_ana', sessionKey: '' }))).toBe('FORBIDDEN');
    expect(codeOf(() => service.proposeBlock(
      { customerId: '', sessionKey: '' }, { cardRef: 'cref_x', reason: 'STOLEN' },
    ))).toBe('FORBIDDEN');
    expect(codeOf(() => service.getProposalStatus({ customerId: 'cus_ana', sessionKey: '' }, 'prop_x'))).toBe('FORBIDDEN');
  });
});

describe('el agente no puede alcanzar lo que no es suyo', () => {
  it('un card_ref de otra sesión devuelve NOT_FOUND, no FORBIDDEN', () => {
    const a = anaIdentity();
    const refA = refFor(a, '4471');
    const b = anaIdentity();

    const code = codeOf(() => service.proposeBlock(b, { cardRef: refA, reason: 'STOLEN' }));
    expect(code).toBe('NOT_FOUND');
  });

  it('un card_ref obtenido con un access token no resuelve con otro (C1)', () => {
    const a = anaIdentity();
    const refA = refFor(a, '4471');
    const b = anaIdentity();

    // Resolución directa a nivel de repositorio, sin pasar por proposeBlock: la referencia de la
    // sesión A no debe resolver bajo la sessionKey de la sesión B.
    expect(repos.cardRefs.resolve(a.sessionKey, refA)).not.toBeNull();
    expect(repos.cardRefs.resolve(b.sessionKey, refA)).toBeNull();
  });

  it('un card_ref inventado queda registrado como intento denegado', () => {
    const identity = anaIdentity();
    codeOf(() => service.proposeBlock(identity, { cardRef: 'cref_inventado', reason: 'STOLEN' }));

    const denied = repos.audit.byCustomer('cus_ana').filter((e) => e.event === 'proposal.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].details.code).toBe('NOT_FOUND');
  });

  it('no se puede confirmar la propuesta de otro cliente', async () => {
    const identity = anaIdentity();
    const proposal = service.proposeBlock(identity, { cardRef: refFor(identity, '4471'), reason: 'LOST' });

    await expect(service.confirmProposal('cus_luis', proposal.proposalId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('validación determinista', () => {
  it('rechaza proponer sobre una tarjeta ya bloqueada', () => {
    const identity = anaIdentity();
    const code = codeOf(() => service.proposeBlock(identity, { cardRef: refFor(identity, '2288'), reason: 'OTHER' }));
    expect(code).toBe('CARD_NOT_ACTIVE');
  });
});

describe('idempotencia y caducidad', () => {
  it('proponer dos veces lo mismo dentro del TTL devuelve la misma propuesta', () => {
    const identity = anaIdentity();
    const ref = refFor(identity, '4471');
    const first = service.proposeBlock(identity, { cardRef: ref, reason: 'STOLEN' });
    const second = service.proposeBlock(identity, { cardRef: ref, reason: 'STOLEN' });
    expect(second.proposalId).toBe(first.proposalId);
  });

  it('una vez caducada, se puede volver a proponer y sale otra propuesta', () => {
    const identity = anaIdentity();
    const ref = refFor(identity, '4471');
    const first = service.proposeBlock(identity, { cardRef: ref, reason: 'STOLEN' });
    clock += 300_001;
    const second = service.proposeBlock(identity, { cardRef: ref, reason: 'STOLEN' });
    expect(second.proposalId).not.toBe(first.proposalId);
  });

  it('no se puede confirmar una propuesta caducada', async () => {
    const identity = anaIdentity();
    const proposal = service.proposeBlock(identity, { cardRef: refFor(identity, '4471'), reason: 'STOLEN' });
    clock += 300_001;

    await expect(service.confirmProposal('cus_ana', proposal.proposalId)).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED' });
    expect(repos.cards.byId('card_ana_1')?.status).toBe('ACTIVE');
  });

  it('confirmar dos veces ejecuta una sola vez', async () => {
    const identity = anaIdentity();
    const proposal = service.proposeBlock(identity, { cardRef: refFor(identity, '4471'), reason: 'STOLEN' });

    const first = await service.confirmProposal('cus_ana', proposal.proposalId);
    const second = await service.confirmProposal('cus_ana', proposal.proposalId);

    expect(first.status).toBe('EXECUTED');
    expect(second.status).toBe('EXECUTED');
    const executions = repos.audit.byCustomer('cus_ana').filter((e) => e.event === 'execution.succeeded');
    expect(executions).toHaveLength(1);
  });
});

describe('fallo de ejecución', () => {
  it('la tarjeta flaky termina en FAILED sin cambiar de estado', async () => {
    const identity = anaIdentity();
    const proposal = service.proposeBlock(identity, { cardRef: refFor(identity, '9013'), reason: 'SUSPECTED_MISUSE' });

    const result = await service.confirmProposal('cus_ana', proposal.proposalId);
    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toBeTruthy();
    expect(repos.cards.byId('card_ana_2')?.status).toBe('ACTIVE');

    const events = repos.audit.byCustomer('cus_ana').map((e) => e.event);
    expect(events).toContain('execution.started');
    expect(events).toContain('execution.failed');
  });
});

describe('rechazo', () => {
  it('rechazar deja la propuesta en REJECTED y la tarjeta intacta', () => {
    const identity = anaIdentity();
    const proposal = service.proposeBlock(identity, { cardRef: refFor(identity, '4471'), reason: 'LOST' });

    const rejected = service.rejectProposal('cus_ana', proposal.proposalId);
    expect(rejected.status).toBe('REJECTED');
    expect(repos.cards.byId('card_ana_1')?.status).toBe('ACTIVE');
  });
});

describe('aislamiento entre clientes distintos (C1)', () => {
  it('list_debit_cards de un cliente nunca incluye tarjetas de otro', () => {
    const ana = anaIdentity();
    const luis = luisIdentity();

    const cardsAna = service.listCards(ana).map((c) => c.cardRef);
    const cardsLuis = service.listCards(luis).map((c) => c.cardRef);

    expect(cardsAna.length).toBeGreaterThan(0);
    expect(cardsLuis.length).toBeGreaterThan(0);
    expect(cardsAna.some((r) => cardsLuis.includes(r))).toBe(false);
  });

  it('un card_ref de un cliente no resuelve con la sessionKey de otro', () => {
    const ana = anaIdentity();
    const luis = luisIdentity();
    const refAna = refFor(ana, '4471');

    const code = codeOf(() => service.proposeBlock(luis, { cardRef: refAna, reason: 'STOLEN' }));
    expect(code).toBe('NOT_FOUND');
  });
});

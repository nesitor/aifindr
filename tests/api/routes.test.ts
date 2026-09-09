import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';
import { createCardBlockService } from '../../src/services/cardBlockService.js';
import { createApp } from '../../src/server.js';

let app: ReturnType<typeof createApp>;
let service: ReturnType<typeof createCardBlockService>;
let repos: ReturnType<typeof createRepositories>;

beforeEach(() => {
  const db = openDatabase(':memory:');
  repos = createRepositories(db);
  seedDatabase(repos, db);
  service = createCardBlockService({
    repos, now: () => Date.now(), ttlSeconds: 300,
    publicBaseUrl: 'https://gateway.test', sleep: async () => {}, executionDelayMs: 0,
  });
  app = createApp({
    service, repos, sessionCookieSecret: 'test-secret',
    publicBaseUrl: 'https://gateway.test', staticDir: null,
  });
});

// Identidad ya resuelta, como la construiría src/mcp/server.ts a partir de un access token OAuth
// verificado (tarea OAuth-B) — estos tests ejercitan la API REST, no el canal MCP, así que no hay
// ningún token real que emitir: basta con una identidad de servicio fija por caso.
function anaIdentity() {
  return { customerId: 'cus_ana', sessionKey: 'skey_ana_routes_test' };
}

async function loginAs(customerId: string) {
  const agent = request.agent(app);
  await agent.post('/api/login').send({ customerId }).expect(200);
  return agent;
}

describe('autenticación web', () => {
  it('sin cookie no se pueden listar tarjetas', async () => {
    await request(app).get('/api/cards').expect(401);
  });

  it('con cookie se listan las tarjetas del cliente', async () => {
    const agent = await loginAs('cus_ana');
    const res = await agent.get('/api/cards').expect(200);
    expect(res.body.cards.length).toBeGreaterThanOrEqual(3);
  });
});

describe('confirmación', () => {
  it('el titular puede confirmar su propuesta', async () => {
    const identity = anaIdentity();
    const ref = service.listCards(identity).find((c) => c.last4 === '4471')!.cardRef;
    const proposal = service.proposeBlock(identity, { cardRef: ref, reason: 'STOLEN' });

    const agent = await loginAs('cus_ana');
    const res = await agent.post(`/api/proposals/${proposal.proposalId}/confirm`).expect(200);
    expect(res.body.proposal.status).toBe('EXECUTED');
  });

  it('otro cliente no puede confirmarla y recibe 404', async () => {
    const identity = anaIdentity();
    const ref = service.listCards(identity).find((c) => c.last4 === '4471')!.cardRef;
    const proposal = service.proposeBlock(identity, { cardRef: ref, reason: 'STOLEN' });

    const agent = await loginAs('cus_luis');
    const res = await agent.post(`/api/proposals/${proposal.proposalId}/confirm`).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('auditoría', () => {
  it('expone el log del cliente autenticado', async () => {
    const identity = anaIdentity();
    const ref = service.listCards(identity).find((c) => c.last4 === '4471')!.cardRef;
    service.proposeBlock(identity, { cardRef: ref, reason: 'LOST' });

    const agent = await loginAs('cus_ana');
    const res = await agent.get('/api/audit').expect(200);
    expect(res.body.entries.map((e: { event: string }) => e.event)).toContain('proposal.created');
  });
});

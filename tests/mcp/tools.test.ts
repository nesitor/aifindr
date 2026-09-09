import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';
import { createCardBlockService } from '../../src/services/cardBlockService.js';
import { buildToolDefs, type ToolIdentity } from '../../src/mcp/tools.js';

let service: ReturnType<typeof createCardBlockService>;
let tools: ReturnType<typeof buildToolDefs>;
let repos: ReturnType<typeof createRepositories>;

beforeEach(() => {
  const db = openDatabase(':memory:');
  repos = createRepositories(db);
  seedDatabase(repos, db);
  service = createCardBlockService({
    repos, now: () => Date.now(), ttlSeconds: 300,
    publicBaseUrl: 'https://gateway.test', sleep: async () => {}, executionDelayMs: 0,
  });
  tools = buildToolDefs(service);
});

function tool(name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} no registrada`);
  return t;
}

// La identidad ya no viaja en los argumentos de la tool (tarea OAuth-B): la construye
// src/mcp/server.ts a partir del access token OAuth verificado, antes de invocar ningún handler.
// Cada llamada a esta función simula una conexión (un access token) distinta, igual que antes cada
// llamada a `service.createAgentSession` creaba una sesión de agente distinta.
let identitySeq = 0;
function identityFor(customerId: string): ToolIdentity {
  identitySeq += 1;
  return { customerId, sessionKey: `skey_${customerId}_${identitySeq}` };
}

describe('superficie MCP', () => {
  it('expone exactamente tres tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_proposal_status', 'list_debit_cards', 'propose_card_block',
    ]);
  });

  it('NINGUNA tool permite confirmar, rechazar o ejecutar', () => {
    const forbidden = /confirm|approve|reject|execute|block_now|apply/i;
    for (const t of tools) {
      expect(t.name).not.toMatch(forbidden);
    }
    expect(tools).toHaveLength(3);
  });

  it('ninguna tool declara un argumento de identidad (session_token o equivalente)', () => {
    // La propiedad central de esta tarea: el agente no puede exfiltrar una identidad que nunca
    // recibe. Si alguna tool volviera a declarar un campo de identidad en su schema, este test
    // lo detecta sin depender de ningún nombre concreto.
    const identityLike = /session|token|customer_?id|client_?id/i;
    for (const t of tools) {
      for (const key of Object.keys(t.schema)) {
        expect(key).not.toMatch(identityLike);
      }
    }
  });

  it('los esquemas acotan la longitud de las entradas de texto libre', () => {
    const huge = 'x'.repeat(200_000);

    const propose = z.object(tool('propose_card_block').schema);
    expect(propose.safeParse({ card_ref: huge, reason: 'STOLEN' }).success).toBe(false);
    expect(propose.safeParse({ card_ref: 'cref_abc', reason: 'STOLEN', note: huge }).success).toBe(false);

    const status = z.object(tool('get_proposal_status').schema);
    expect(status.safeParse({ proposal_id: huge }).success).toBe(false);

    const list = z.object(tool('list_debit_cards').schema);
    expect(list.safeParse({}).success).toBe(true);

    // Y un caso válido debe seguir pasando, para que el test no sea trivialmente verde.
    expect(propose.safeParse({ card_ref: 'cref_abc', reason: 'STOLEN' }).success).toBe(true);
  });
});

describe('comportamiento de las tools', () => {
  it('list_debit_cards no expone identificadores internos ni PAN', async () => {
    const identity = identityFor('cus_ana');
    const out = JSON.parse(await tool('list_debit_cards').handler({}, identity));

    expect(out.cards[0]).toHaveProperty('cardRef');
    expect(out.cards[0]).not.toHaveProperty('id');
    expect(JSON.stringify(out)).not.toMatch(/card_ana_/);
  });

  it('propose_card_block con un ref de otra sesión responde no encontrado', async () => {
    const a = identityFor('cus_ana');
    const refA = service.listCards(a)[0].cardRef;
    const b = identityFor('cus_ana');

    const out = await tool('propose_card_block').handler(
      { card_ref: refA, reason: 'STOLEN' },
      b,
    );

    expect(out).toMatch(/does not exist in this session/i);
    expect(out).not.toMatch(/prohibid|forbidden/i);
  });

  it('get_proposal_status devuelve el estado de una propuesta propia', async () => {
    const identity = identityFor('cus_ana');
    const ref = service.listCards(identity).find((c) => c.status === 'ACTIVE')!.cardRef;
    const created = JSON.parse(await tool('propose_card_block').handler(
      { card_ref: ref, reason: 'LOST' },
      identity,
    ));

    const status = JSON.parse(await tool('get_proposal_status').handler(
      { proposal_id: created.proposalId },
      identity,
    ));
    expect(status.status).toBe('PROPOSED');
  });

  it('ninguna secuencia de llamadas a tools puede mover el estado más allá de PROPOSED', async () => {
    const identity = identityFor('cus_ana');
    const otra = identityFor('cus_luis');
    const refPropio = service.listCards(identity).find((c) => c.status === 'ACTIVE')!.cardRef;
    const refAjeno = service.listCards(otra)[0].cardRef;

    // Una propuesta REAL y viva: sin un id vivo en la matriz, una tool maliciosa
    // con la misma forma que las reales nunca recibiría nada que confirmar.
    const creada = service.proposeBlock(identity, { cardRef: refPropio, reason: 'STOLEN' });
    const idVivo = creada.proposalId;

    const estadoInicial = repos.cards.byCustomer('cus_ana').map((c) => `${c.id}:${c.status}`).join(',');

    // Cajón de sastre: todas las claves que cualquier tool del sistema podría leer de `args`,
    // con valores reales — incluidas claves de identidad, por si una tool nueva decidiera leer
    // el cliente o la sesión de los ARGUMENTOS en vez de la identidad ya resuelta que se le pasa
    // aparte. Una tool nueva que lea cualquiera de ellas recibe algo utilizable.
    const cajonDeSastre: Record<string, unknown> = {
      customer_id: 'cus_ana',
      customerId: 'cus_ana',
      session_key: identity.sessionKey,
      sessionKey: identity.sessionKey,
      card_ref: refPropio,
      cardRef: refPropio,
      reason: 'STOLEN',
      proposal_id: idVivo,
      proposalId: idVivo,
      note: 'confirmado por el titular',
    };

    const argumentos: Array<Record<string, unknown>> = [
      cajonDeSastre,
      {},
      { proposal_id: idVivo },
      { card_ref: refPropio, reason: 'LOST' },
      { card_ref: refAjeno, reason: 'STOLEN' },
      { card_ref: 'cref_basura', reason: 'OTHER' },
    ];

    // La identidad ya no es parte de `args` (ver arriba), así que la matriz también varía la
    // identidad con la que se llama a cada combinación de argumentos: la propia, la de otra
    // sesión de OTRO cliente, y una sesión inventada del mismo cliente. Ninguna combinación debe
    // mover ninguna propuesta más allá de PROPOSED.
    const identidades: ToolIdentity[] = [
      identity,
      otra,
      { customerId: 'cus_ana', sessionKey: 'skey_basura' },
    ];

    for (const def of tools) {
      for (const args of argumentos) {
        for (const ident of identidades) {
          await def.handler(args, ident);
        }
      }
    }

    expect(repos.cards.byCustomer('cus_ana').map((c) => `${c.id}:${c.status}`).join(',')).toBe(estadoInicial);

    const eventos = repos.audit.byCustomer('cus_ana').map((e) => e.event);
    expect(eventos).not.toContain('proposal.confirmed');
    expect(eventos.filter((e) => e.startsWith('execution.'))).toHaveLength(0);

    for (const p of service.listProposals('cus_ana')) expect(p.effective).toBe('PROPOSED');
  });
});

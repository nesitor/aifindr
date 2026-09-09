import type { Repositories } from '../db/repositories.js';
import { DomainError } from '../domain/errors.js';
import {
  assertConfirmable, beginExecution, completeExecution, confirm, effectiveStatus, failExecution, reject,
} from '../domain/proposals.js';
import { idempotencyKey, newId, newRef } from '../domain/refs.js';
import {
  CARD_BLOCK_ACTION, type ActorType, type BlockReason, type CardStatus, type Proposal, type ProposalStatus,
} from '../domain/types.js';

export interface CardView { cardRef: string; last4: string; brand: string; status: CardStatus }

/**
 * Identidad de la llamada MCP, ya verificada por OAuth antes de llegar aquí (ver
 * `src/oauth/provider.ts` y `src/mcp/server.ts`). `customerId` es el cliente de banca dueño del
 * access token; `sessionKey` es el hash de ese token — lo que antes acotaba `card_refs` era el id
 * de una fila en `agent_sessions` (tabla eliminada en la tarea OAuth-B), ahora es el propio token
 * (C1 se mantiene: las referencias siguen siendo opacas y acotadas a una sesión — spec §18).
 *
 * Ninguno de los dos campos es opcional a nivel de tipo, pero eso por sí solo no basta —
 * `requireIdentity` de abajo comprueba también que ninguno llegue vacío, para que un fallo de
 * `resolveIdentity` en `src/mcp/server.ts` (o una llamada directa a este servicio, como hacen los
 * tests) nunca se cuele como una operación con identidad ausente o por defecto.
 */
export interface Identity { customerId: string; sessionKey: string }

export interface ProposeInput { cardRef: string; reason: BlockReason; note?: string }
export interface ProposeResult {
  proposalId: string; status: ProposalStatus; expiresAt: number; confirmationUrl: string; summary: string;
}

export interface ServiceDeps {
  repos: Repositories;
  now: () => number;
  ttlSeconds: number;
  publicBaseUrl: string;
  sleep?: (ms: number) => Promise<void>;
  executionDelayMs?: number;
}

function requireIdentity(identity: Identity): Identity {
  if (!identity.customerId || !identity.sessionKey) {
    throw new DomainError('FORBIDDEN', 'Unverified identity.');
  }
  return identity;
}

export function createCardBlockService(deps: ServiceDeps) {
  const { repos, now, ttlSeconds, publicBaseUrl } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const executionDelayMs = deps.executionDelayMs ?? 400;

  function audit(
    customerId: string, actorType: ActorType, actorId: string, event: string,
    details: Record<string, unknown>, proposalId: string | null = null, cardId: string | null = null,
  ): void {
    repos.audit.append({ ts: now(), customerId, actorType, actorId, event, proposalId, cardId, details });
  }

  function view(p: Proposal): ProposeResult {
    const card = repos.cards.byId(p.cardId);
    const label = card ? `${card.brand} ****${card.last4}` : 'the card';
    return {
      proposalId: p.id,
      status: effectiveStatus(p, now()),
      expiresAt: p.expiresAt,
      confirmationUrl: `${publicBaseUrl}/proposals/${p.id}`,
      summary: `Block ${label} for reason ${p.reason}. The cardholder must confirm it in online banking.`,
    };
  }

  function ownedProposal(customerId: string, proposalId: string): Proposal {
    const p = repos.proposals.byId(proposalId);
    if (!p || p.customerId !== customerId) throw new DomainError('NOT_FOUND', 'Proposal not found.');
    return p;
  }

  return {
    listCards(identity: Identity): CardView[] {
      const { customerId, sessionKey } = requireIdentity(identity);
      return repos.cards.byCustomer(customerId).map((c) => {
        const ref = newRef();
        repos.cardRefs.put(sessionKey, ref, c.id);
        return { cardRef: ref, last4: c.last4, brand: c.brand, status: c.status };
      });
    },

    proposeBlock(identity: Identity, input: ProposeInput): ProposeResult {
      const { customerId, sessionKey } = requireIdentity(identity);

      const cardId = repos.cardRefs.resolve(sessionKey, input.cardRef);
      if (!cardId) {
        audit(customerId, 'AGENT', sessionKey, 'proposal.denied', { code: 'NOT_FOUND', cardRef: input.cardRef });
        throw new DomainError('NOT_FOUND', 'That card does not exist in this session.');
      }

      const card = repos.cards.byId(cardId);
      if (!card) throw new DomainError('NOT_FOUND', 'That card does not exist in this session.');

      if (card.status !== 'ACTIVE') {
        audit(customerId, 'AGENT', sessionKey, 'proposal.denied', { code: 'CARD_NOT_ACTIVE', status: card.status }, null, card.id);
        throw new DomainError('CARD_NOT_ACTIVE', `The card is not active (current status: ${card.status}).`);
      }

      const t = now();
      const key = idempotencyKey(sessionKey, card.id, input.reason);
      const live = repos.proposals.byLiveIdempotencyKey(key, t);
      if (live) return view(live);

      const proposal: Proposal = {
        id: newId('prop'), sessionId: sessionKey, customerId, cardId: card.id,
        action: CARD_BLOCK_ACTION, reason: input.reason, note: input.note ?? null,
        status: 'PROPOSED', idempotencyKey: key,
        createdAt: t, expiresAt: t + ttlSeconds * 1000,
        confirmedAt: null, executedAt: null, failureReason: null,
      };
      repos.proposals.insert(proposal);
      audit(customerId, 'AGENT', sessionKey, 'proposal.created', { reason: proposal.reason, last4: card.last4 }, proposal.id, card.id);
      return view(proposal);
    },

    getProposalStatus(identity: Identity, proposalId: string): ProposeResult {
      const { customerId, sessionKey } = requireIdentity(identity);
      const p = repos.proposals.byId(proposalId);
      if (!p || p.customerId !== customerId || p.sessionId !== sessionKey) {
        throw new DomainError('NOT_FOUND', 'Proposal not found.');
      }
      return view(p);
    },

    async confirmProposal(customerId: string, proposalId: string): Promise<Proposal> {
      const p = ownedProposal(customerId, proposalId);
      const status = effectiveStatus(p, now());

      // Idempotente: si ya se confirmó, se devuelve el estado actual sin re-ejecutar.
      if (status === 'CONFIRMED' || status === 'EXECUTING' || status === 'EXECUTED' || status === 'FAILED') {
        return { ...p, status };
      }
      assertConfirmable(p, now());

      const confirmed = confirm(p, now());
      repos.proposals.save(confirmed);
      audit(customerId, 'HUMAN', customerId, 'proposal.confirmed', {}, p.id, p.cardId);

      // EXECUTING se persiste ANTES de tocar la tarjeta: si el proceso muere aquí,
      // la propuesta queda distinguible de una que nunca empezó.
      const executing = beginExecution(confirmed, now());
      repos.proposals.save(executing);
      audit(customerId, 'SYSTEM', 'gateway', 'execution.started', {}, p.id, p.cardId);

      await sleep(executionDelayMs);

      const card = repos.cards.byId(p.cardId);
      if (!card) throw new DomainError('NOT_FOUND', 'The card no longer exists.');

      if (card.isFlaky) {
        const failed = failExecution(executing, now(), 'The issuer did not respond in time.');
        repos.proposals.save(failed);
        audit(customerId, 'SYSTEM', 'gateway', 'execution.failed', { reason: failed.failureReason }, p.id, p.cardId);
        return failed;
      }

      repos.cards.setStatus(card.id, 'BLOCKED');
      const done = completeExecution(executing, now());
      repos.proposals.save(done);
      audit(customerId, 'SYSTEM', 'gateway', 'execution.succeeded', { last4: card.last4 }, p.id, p.cardId);
      return done;
    },

    rejectProposal(customerId: string, proposalId: string): Proposal {
      const p = ownedProposal(customerId, proposalId);
      const rejected = reject(p, now());
      repos.proposals.save(rejected);
      audit(customerId, 'HUMAN', customerId, 'proposal.rejected', {}, p.id, p.cardId);
      return rejected;
    },

    listProposals(customerId: string): Array<Proposal & { effective: ProposalStatus }> {
      return repos.proposals.byCustomer(customerId).map((p) => ({ ...p, effective: effectiveStatus(p, now()) }));
    },
  };
}

export type CardBlockService = ReturnType<typeof createCardBlockService>;

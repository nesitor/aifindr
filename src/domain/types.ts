export type CardStatus = 'ACTIVE' | 'BLOCKED' | 'CANCELLED';

export type ProposalStatus =
  | 'PROPOSED'
  | 'CONFIRMED'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'FAILED'
  | 'REJECTED'
  | 'EXPIRED';

export type BlockReason = 'LOST' | 'STOLEN' | 'SUSPECTED_MISUSE' | 'OTHER';

export type ActorType = 'AGENT' | 'HUMAN' | 'SYSTEM';

export const CARD_BLOCK_ACTION = 'card.block' as const;
export type CardBlockAction = typeof CARD_BLOCK_ACTION;

export interface Card {
  id: string;
  customerId: string;
  last4: string;
  brand: string;
  type: 'debit';
  status: CardStatus;
  isFlaky: boolean;
}

export interface Proposal {
  id: string;
  /** Tarea OAuth-B: ya no el id de una fila en `agent_sessions` (tabla eliminada) — el hash del
   * access token OAuth que creó la propuesta (`sessionKey`, ver `src/services/cardBlockService.ts`). */
  sessionId: string;
  customerId: string;
  cardId: string;
  action: CardBlockAction;
  reason: BlockReason;
  note: string | null;
  status: ProposalStatus;
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number;
  confirmedAt: number | null;
  executedAt: number | null;
  failureReason: string | null;
}

export interface AuditEntry {
  id: number;
  ts: number;
  customerId: string;
  actorType: ActorType;
  actorId: string;
  event: string;
  proposalId: string | null;
  cardId: string | null;
  details: Record<string, unknown>;
}

/** Titular de una o más tarjetas. La tabla `customers` es la única fuente de verdad. */
export interface Customer {
  id: string;
  name: string;
}

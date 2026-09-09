import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import type { CardBlockService } from '../services/cardBlockService.js';

/**
 * Identidad ya resuelta por el transporte, no por el contenido de la llamada (tarea OAuth-B, ver
 * docs/superpowers/specs/2026-09-08-mcp-card-block-gateway-design.md §18). `src/mcp/server.ts` la
 * construye a partir del `authInfo` que el SDK cuelga de cada tool call, verificado antes por
 * `requireBearerAuth` + `verifyAccessToken` (`src/oauth/provider.ts`). Ninguna tool la recibe como
 * argumento: no hay campo en ningún `schema` de aquí abajo por el que un agente inyectado pueda
 * inventarse, adivinar o exfiltrar una identidad — no puede exfiltrar lo que no tiene.
 */
export interface ToolIdentity {
  customerId: string;
  sessionKey: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, identity: ToolIdentity) => Promise<string>;
}

const REASONS = ['LOST', 'STOLEN', 'SUSPECTED_MISUSE', 'OTHER'] as const;

async function guard(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await fn());
  } catch (err) {
    if (err instanceof DomainError) return err.message;
    return 'The operation could not be completed.';
  }
}

export function buildToolDefs(service: CardBlockService): ToolDef[] {
  return [
    {
      name: 'list_debit_cards',
      description:
        'Lists the debit cards of the customer authenticated on this connection. Takes no arguments. Use it ' +
        'whenever the customer wants to block, freeze, cancel or report a debit card as lost, stolen or misused: ' +
        'call it FIRST to obtain the card_ref. Returns, per card, an opaque card_ref plus last4, brand and ' +
        'status; only a card whose status is ACTIVE can be blocked.',
      schema: {},
      handler: (_args, identity) => guard(() => ({ cards: service.listCards(identity) })),
    },
    {
      name: 'propose_card_block',
      description:
        'Requests the block of a debit card the customer owns. It does NOT execute the block: it creates a ' +
        'proposal that the cardholder must confirm personally in online banking, which is the only place a block ' +
        'becomes real. Requires a card_ref obtained from list_debit_cards in this same conversation. Returns ' +
        'proposalId, status, expiresAt, a confirmationUrl to hand to the customer, and a readable summary.',
      schema: {
        card_ref: z
          .string()
          .max(128)
          .describe('Opaque reference for the card, exactly as returned by list_debit_cards in this conversation.'),
        reason: z.enum(REASONS).describe('Why the customer wants the card blocked.'),
        note: z.string().max(280).optional().describe("Optional free-text detail from the customer."),
      },
      handler: (args, identity) =>
        guard(() =>
          service.proposeBlock(identity, {
            cardRef: String(args.card_ref),
            reason: args.reason as (typeof REASONS)[number],
            note: args.note === undefined ? undefined : String(args.note),
          }),
        ),
    },
    {
      name: 'get_proposal_status',
      description:
        'Checks the status of a block proposal created earlier in this conversation. This is the ONLY way to ' +
        'learn whether the cardholder confirmed it; never assume a confirmation you have not observed here.',
      schema: {
        proposal_id: z.string().max(128).describe('The proposalId returned by propose_card_block.'),
      },
      handler: (args, identity) => guard(() => service.getProposalStatus(identity, String(args.proposal_id))),
    },
  ];
}

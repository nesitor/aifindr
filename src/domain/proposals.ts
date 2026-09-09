import { DomainError } from './errors.js';
import type { Proposal, ProposalStatus } from './types.js';

export function effectiveStatus(p: Proposal, now: number): ProposalStatus {
  if (p.status === 'PROPOSED' && now >= p.expiresAt) return 'EXPIRED';
  return p.status;
}

export function assertConfirmable(p: Proposal, now: number): void {
  const status = effectiveStatus(p, now);
  if (status === 'EXPIRED') {
    throw new DomainError('PROPOSAL_EXPIRED', 'The proposal has expired.');
  }
  if (status !== 'PROPOSED') {
    throw new DomainError(
      'PROPOSAL_NOT_PENDING',
      `The proposal is no longer pending (status: ${status}).`,
    );
  }
}

export function confirm(p: Proposal, now: number): Proposal {
  assertConfirmable(p, now);
  return { ...p, status: 'CONFIRMED', confirmedAt: now };
}

export function reject(p: Proposal, now: number): Proposal {
  assertConfirmable(p, now);
  return { ...p, status: 'REJECTED' };
}

export function beginExecution(p: Proposal, now: number): Proposal {
  if (p.status !== 'CONFIRMED') {
    throw new DomainError(
      'PROPOSAL_NOT_CONFIRMED',
      `Only a confirmed proposal can be executed (status: ${p.status}).`,
    );
  }
  return { ...p, status: 'EXECUTING' };
}

export function completeExecution(p: Proposal, now: number): Proposal {
  if (p.status !== 'EXECUTING') {
    throw new DomainError(
      'PROPOSAL_NOT_CONFIRMED',
      `Only an executing proposal can be completed (status: ${p.status}).`,
    );
  }
  return { ...p, status: 'EXECUTED', executedAt: now };
}

export function failExecution(p: Proposal, now: number, reason: string): Proposal {
  if (p.status !== 'EXECUTING') {
    throw new DomainError(
      'PROPOSAL_NOT_CONFIRMED',
      `Only an executing proposal can fail (status: ${p.status}).`,
    );
  }
  return { ...p, status: 'FAILED', executedAt: now, failureReason: reason };
}

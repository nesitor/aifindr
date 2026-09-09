export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CARD_NOT_ACTIVE'
  | 'PROPOSAL_NOT_PENDING'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_NOT_CONFIRMED';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

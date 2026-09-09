export interface CardDto { id: string; last4: string; brand: string; status: string }
export interface ProposalDto {
  id: string; cardId: string; reason: string; note: string | null;
  effective: string; createdAt: number; expiresAt: number; failureReason: string | null;
}
export interface AuditDto {
  id: number; ts: number; actorType: string; actorId: string; event: string;
  proposalId: string | null; cardId: string | null; details: Record<string, unknown>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
    credentials: 'include',
  });

  let body: (T & { error?: string }) | null = null;
  try {
    body = (await res.json()) as T & { error?: string };
  } catch {
    body = null;
  }

  if (!res.ok) throw new Error(body?.error ?? `The server responded ${res.status}.`);
  if (body === null) throw new Error('The server returned an unreadable response.');
  return body;
}

export interface CustomerDto { id: string; name: string }

/** Titulares dados de alta en la base; alimenta el login simulado de la demo. */
export const getCustomers = async () =>
  (await call<{ customers: CustomerDto[] }>('/api/customers')).customers;

export const login = (customerId: string) =>
  call<{ customerId: string }>('/api/login', { method: 'POST', body: JSON.stringify({ customerId }) });

export const logout = () => call<{ ok: boolean }>('/api/logout', { method: 'POST' });

export const getCards = () => call<{ cards: CardDto[]; demoMode: boolean }>('/api/cards');

/** Atajo de demostración; sólo responde con DEMO_MODE=true. No es una operación bancaria. */
export const resetCard = (id: string) =>
  call<{ card: CardDto }>(`/api/cards/${id}/reset`, { method: 'POST' });

export const getProposals = async () => (await call<{ proposals: ProposalDto[] }>('/api/proposals')).proposals;

export const confirmProposal = (id: string) =>
  call<{ proposal: ProposalDto }>(`/api/proposals/${id}/confirm`, { method: 'POST' });

export const rejectProposal = (id: string) =>
  call<{ proposal: ProposalDto }>(`/api/proposals/${id}/reject`, { method: 'POST' });

export const getAudit = async () => (await call<{ entries: AuditDto[] }>('/api/audit')).entries;

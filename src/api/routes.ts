import { Router } from 'express';
import type { Repositories } from '../db/repositories.js';
import { DomainError } from '../domain/errors.js';
import type { CardBlockService } from '../services/cardBlockService.js';
import { requireCustomer, SESSION_COOKIE } from './auth.js';

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CARD_NOT_ACTIVE: 409,
  PROPOSAL_NOT_PENDING: 409,
  PROPOSAL_EXPIRED: 409,
  PROPOSAL_NOT_CONFIRMED: 409,
};

function send(res: import('express').Response, err: unknown): void {
  if (err instanceof DomainError) {
    res.status(STATUS_BY_CODE[err.code] ?? 400).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: 'Internal error.' });
}

export function createApiRouter(service: CardBlockService, repos: Repositories, demoMode = false): Router {
  const router = Router();

  // Login simulado de la demo: la pantalla necesita la lista ANTES de que haya sesión, así que
  // esta ruta es pública. No es una fuga nueva —la misma lista se muestra en /oauth/consent/login
  // y antes venía escrita en el bundle de la SPA— pero desaparecería junto con el login simulado
  // en cuanto hubiera un IdP real.
  router.get('/customers', (_req, res) => {
    res.json({ customers: repos.customers.list() });
  });

  router.post('/login', (req, res) => {
    const customerId = String(req.body?.customerId ?? '');
    if (!customerId || !repos.customers.byId(customerId)) {
      res.status(400).json({ error: 'Unknown customer.' });
      return;
    }
    res.cookie(SESSION_COOKIE, customerId, { httpOnly: true, signed: true, sameSite: 'lax' });
    res.json({ customerId });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  router.get('/cards', requireCustomer, (_req, res) => {
    res.json({ cards: repos.cards.byCustomer(res.locals.customerId as string), demoMode });
  });

  // Atajo de demostración, NO una operación bancaria. Existe sólo con DEMO_MODE=true
  // para poder repetir el flujo sin resembrar la base. Vive aquí, fuera de
  // cardBlockService, precisamente para que el núcleo de seguridad no tenga ningún
  // camino de desbloqueo, y jamás se expone como tool MCP.
  if (demoMode) {
    router.post<{ id: string }>('/cards/:id/reset', requireCustomer, (req, res) => {
      const customerId = res.locals.customerId as string;
      const card = repos.cards.byId(req.params.id);
      if (!card || card.customerId !== customerId) {
        res.status(404).json({ error: 'Card not found.', code: 'NOT_FOUND' });
        return;
      }
      repos.cards.setStatus(card.id, 'ACTIVE');
      repos.audit.append({
        ts: Date.now(),
        customerId,
        actorType: 'HUMAN',
        actorId: customerId,
        event: 'card.reset_demo',
        proposalId: null,
        cardId: card.id,
        details: { from: card.status, to: 'ACTIVE', note: 'Demo reset, not a banking operation.' },
      });
      res.json({ card: { ...card, status: 'ACTIVE' } });
    });
  }

  router.get('/proposals', requireCustomer, (_req, res) => {
    res.json({ proposals: service.listProposals(res.locals.customerId as string) });
  });

  router.get('/proposals/:id', requireCustomer, (req, res) => {
    const found = service.listProposals(res.locals.customerId as string).find((p) => p.id === req.params.id);
    if (!found) {
      res.status(404).json({ error: 'Proposal not found.' });
      return;
    }
    res.json({ proposal: found });
  });

  router.post<{ id: string }>('/proposals/:id/confirm', requireCustomer, async (req, res) => {
    try {
      const proposal = await service.confirmProposal(res.locals.customerId as string, req.params.id);
      res.json({ proposal });
    } catch (err) {
      send(res, err);
    }
  });

  router.post<{ id: string }>('/proposals/:id/reject', requireCustomer, (req, res) => {
    try {
      res.json({ proposal: service.rejectProposal(res.locals.customerId as string, req.params.id) });
    } catch (err) {
      send(res, err);
    }
  });

  router.get('/audit', requireCustomer, (_req, res) => {
    res.json({ entries: repos.audit.byCustomer(res.locals.customerId as string) });
  });

  return router;
}

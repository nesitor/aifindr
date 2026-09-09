import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmProposal, getCards } from '../../web/src/api';

describe('cliente HTTP de la SPA', () => {
  // El stub de fetch es global: restaurarlo evita que se filtre a otros tests.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('envía las credenciales de sesión al listar tarjetas', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cards: [{ id: 'card_ana_1', last4: '4471', status: 'ACTIVE' }], demoMode: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { cards, demoMode } = await getCards();

    expect(cards).toHaveLength(1);
    expect(demoMode).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/cards', expect.objectContaining({ credentials: 'include' }));
  });

  it('propaga el mensaje de error del servidor al confirmar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: 'The proposal has expired.', code: 'PROPOSAL_EXPIRED' }),
    }));

    await expect(confirmProposal('prop_1')).rejects.toThrow('The proposal has expired.');
  });
});

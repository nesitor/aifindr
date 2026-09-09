import { useCallback, useEffect, useState } from 'react';
import { confirmProposal, getCards, getProposals, rejectProposal, type CardDto, type ProposalDto } from '../api.js';

export function Inbox() {
  const [proposals, setProposals] = useState<ProposalDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<CardDto[]>([]);

  // getCards() se reintenta en cada sondeo (junto con getProposals()), no solo al montar. Si esta
  // petición falla y `cards` no se refresca, `cardLabel`/`verificada` no pueden resolver la tarjeta
  // de una propuesta contra nada que el titular pueda comprobar — y el botón de confirmar de más
  // abajo se deshabilita en ese caso. Fallar en cerrado: sin poder verificar, no se puede confirmar.
  const refresh = useCallback(() => {
    void getProposals().then(setProposals).catch(() => {});
    void getCards().then((r) => setCards(r.cards)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  function cardLabel(cardId: string): string {
    const card = cards.find((c) => c.id === cardId);
    return card ? `${card.brand} ****${card.last4}` : cardId;
  }

  async function act(id: string, action: 'confirm' | 'reject') {
    setError(null);
    try {
      await (action === 'confirm' ? confirmProposal(id) : rejectProposal(id));
    } catch (err) {
      setError((err as Error).message);
    }
    refresh();
  }

  const pending = proposals.filter((p) => p.effective === 'PROPOSED');
  const rest = proposals.filter((p) => p.effective !== 'PROPOSED');

  return (
    <>
      {error && <p style={{ color: '#b00' }}>{error}</p>}

      <h2 style={{ fontSize: '1rem' }}>Pending confirmation</h2>
      {pending.length === 0 && <p style={{ color: '#666' }}>Nothing pending.</p>}
      {pending.map((p) => {
        // NOTA DE SEGURIDAD: p.note (el texto libre que el agente adjuntó a la propuesta) se
        // recibe aquí pero NUNCA se renderiza. Es intencional: esta es la única pantalla donde un
        // humano decide si confirma una acción propuesta por un llamante no confiable (el agente,
        // potencialmente comprometido por inyección de prompt). Mostrar `p.note` abriría un canal
        // de inyección directo hacia esa decisión (texto del agente pudiendo manipular al titular
        // en el momento exacto de aprobar). Si en el futuro se necesita mostrar el motivo, usa
        // `p.reason` (un enum cerrado, no texto libre) — no `p.note`.
        const verificada = cards.some((c) => c.id === p.cardId);
        return (
          <article key={p.id} style={{ border: '1px solid #ddd', padding: '1rem', marginBottom: '0.75rem' }}>
            <p style={{ margin: 0 }}>
              <strong>Block {cardLabel(p.cardId)}</strong> — reason: {p.reason}
            </p>
            <p style={{ margin: '0.25rem 0', color: '#666' }}>
              Proposed by the assistant. Expires at {new Date(p.expiresAt).toLocaleTimeString()}.
            </p>
            <button disabled={!verificada} onClick={() => void act(p.id, 'confirm')}>
              Confirm block
            </button>{' '}
            <button onClick={() => void act(p.id, 'reject')}>Reject</button>
            {!verificada && (
              <p style={{ color: '#b00', margin: '0.5rem 0 0' }}>
                The card cannot be verified right now. Do not confirm blindly.
              </p>
            )}
          </article>
        );
      })}

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>History</h2>
      <ul>
        {rest.map((p) => (
          <li key={p.id}>
            {cardLabel(p.cardId)} — {p.reason} — <strong>{p.effective}</strong>
            {p.failureReason ? ` (${p.failureReason})` : ''}
          </li>
        ))}
      </ul>
    </>
  );
}

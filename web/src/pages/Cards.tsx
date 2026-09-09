import { useCallback, useEffect, useState } from 'react';
import { getCards, resetCard, type CardDto } from '../api.js';

export function Cards() {
  const [cards, setCards] = useState<CardDto[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void getCards()
      .then((r) => { setCards(r.cards); setDemoMode(r.demoMode); })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  async function reset(id: string) {
    setError(null);
    try {
      await resetCard(id);
    } catch (err) {
      setError((err as Error).message);
    }
    refresh();
  }

  return (
    <>
      {error && <p style={{ color: '#b00' }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Card</th>
            <th align="left">Status</th>
            {demoMode && <th align="left" />}
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.id} style={{ borderTop: '1px solid #eee' }}>
              <td style={{ padding: '0.5rem 0' }}>{c.brand} ****{c.last4}</td>
              <td>{c.status}</td>
              {demoMode && (
                <td align="right">
                  {c.status === 'BLOCKED' && (
                    <button onClick={() => void reset(c.id)}>Reset to ACTIVE</button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {demoMode && (
        <p style={{ color: '#666', marginTop: '1rem', fontSize: '0.9rem' }}>
          Demo mode is on (<code>DEMO_MODE=true</code>). Resetting a card is a shortcut for
          repeating the demo: it is not a banking operation, it does not go through the propose
          and confirm flow, and it is not exposed as an MCP tool. It is recorded in the audit log
          as <code>card.reset_demo</code>.
        </p>
      )}
    </>
  );
}

import { useState } from 'react';
import { logout } from './api.js';
import { Audit } from './pages/Audit.js';
import { Cards } from './pages/Cards.js';
import { Inbox } from './pages/Inbox.js';
import { Login } from './pages/Login.js';

type Tab = 'cards' | 'inbox' | 'audit';

export function App() {
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('inbox');

  if (!customerId) return <Login onLogin={setCustomerId} />;

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 820, margin: '2rem auto', padding: '0 1rem' }}>
      <header style={{ display: 'flex', gap: '1rem', alignItems: 'baseline', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Online Banking</h1>
        <span style={{ color: '#666' }}>{customerId}</span>
        <button style={{ marginLeft: 'auto' }} onClick={() => void logout().then(() => setCustomerId(null))}>
          Sign out
        </button>
      </header>

      <nav style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <button onClick={() => setTab('inbox')} disabled={tab === 'inbox'}>Confirmations</button>
        <button onClick={() => setTab('cards')} disabled={tab === 'cards'}>My cards</button>
        <button onClick={() => setTab('audit')} disabled={tab === 'audit'}>Audit</button>
      </nav>

      {tab === 'inbox' && <Inbox />}
      {tab === 'cards' && <Cards />}
      {tab === 'audit' && <Audit />}
    </main>
  );
}

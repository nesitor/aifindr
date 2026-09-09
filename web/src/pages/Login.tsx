import { useEffect, useState } from 'react';
import { getCustomers, login, type CustomerDto } from '../api.js';

export function Login({ onLogin }: { onLogin: (customerId: string) => void }) {
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Los titulares salen de la base de datos, no de una lista escrita aquí: dar de alta uno nuevo
  // lo hace aparecer en esta pantalla, en /oauth/consent/login y en POST /api/login por igual.
  useEffect(() => {
    void getCustomers().then(setCustomers).catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 420, margin: '4rem auto', padding: '0 1rem' }}>
      <h1 style={{ fontSize: '1.25rem' }}>Sign in as</h1>
      <p style={{ color: '#666' }}>Simulated sign-in: no passwords, no real identity.</p>
      {error && <p style={{ color: '#b00' }}>{error}</p>}
      {!error && customers.length === 0 && <p style={{ color: '#666' }}>Loading customers…</p>}
      {customers.map((c) => (
        <button
          key={c.id}
          style={{ display: 'block', width: '100%', padding: '0.75rem', marginBottom: '0.5rem' }}
          onClick={() => void login(c.id).then(() => onLogin(c.id))}
        >
          {c.name}
        </button>
      ))}
    </main>
  );
}

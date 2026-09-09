import { useEffect, useState } from 'react';
import { getAudit, type AuditDto } from '../api.js';

export function Audit() {
  const [entries, setEntries] = useState<AuditDto[]>([]);
  useEffect(() => { void getAudit().then(setEntries); }, []);

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
      <thead>
        <tr><th align="left">Time</th><th align="left">Actor</th><th align="left">Event</th><th align="left">Details</th></tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} style={{ borderTop: '1px solid #eee' }}>
            <td style={{ padding: '0.35rem 0' }}>{new Date(e.ts).toLocaleTimeString()}</td>
            <td>{e.actorType}</td>
            <td>{e.event}</td>
            <td><code>{JSON.stringify(e.details)}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

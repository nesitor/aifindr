import type Database from 'better-sqlite3';
import type { Repositories } from './repositories.js';

export function seedDatabase(_repos: Repositories, db: Database.Database): void {
  const already = db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number };
  if (already.n > 0) return;

  const customers = [
    { id: 'cus_ana', name: 'Ana Quispe' },
    { id: 'cus_luis', name: 'Luis Ramírez' },
  ];
  const cards = [
    { id: 'card_ana_1', customerId: 'cus_ana', last4: '4471', brand: 'Visa', status: 'ACTIVE', isFlaky: 0 },
    { id: 'card_ana_2', customerId: 'cus_ana', last4: '9013', brand: 'Mastercard', status: 'ACTIVE', isFlaky: 1 },
    { id: 'card_ana_3', customerId: 'cus_ana', last4: '2288', brand: 'Visa', status: 'BLOCKED', isFlaky: 0 },
    { id: 'card_luis_1', customerId: 'cus_luis', last4: '7702', brand: 'Visa', status: 'ACTIVE', isFlaky: 0 },
  ];

  const insertCustomer = db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)');
  const insertCard = db.prepare(
    'INSERT INTO cards (id, customer_id, last4, brand, type, status, is_flaky) VALUES (?,?,?,?,?,?,?)',
  );

  db.transaction(() => {
    for (const c of customers) insertCustomer.run(c.id, c.name);
    for (const c of cards) insertCard.run(c.id, c.customerId, c.last4, c.brand, 'debit', c.status, c.isFlaky);
  })();
}

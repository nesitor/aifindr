import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';
import { createCardBlockService } from '../../src/services/cardBlockService.js';
import { createApp } from '../../src/server.js';

const BASE = 'https://gateway.test';

let app: ReturnType<typeof createApp>;
let repos: Repositories;
let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  seedDatabase(repos, db);
  const service = createCardBlockService({
    repos, now: () => Date.now(), ttlSeconds: 300, publicBaseUrl: BASE,
  });
  app = createApp({
    service, repos, sessionCookieSecret: 'test-secret', publicBaseUrl: BASE, staticDir: null,
  });
});

/**
 * Se da de alta DESPUÉS de construir la app, a propósito: si alguna pantalla siguiera leyendo de
 * una lista escrita en el código (o cacheara la consulta al arrancar), este cliente no aparecería.
 */
function insertCustomer(id: string, name: string): void {
  db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)').run(id, name);
}

async function pendingRequestId(): Promise<string> {
  const reg = await request(app)
    .post('/register')
    .send({ redirect_uris: ['http://localhost:9999/cb'], token_endpoint_auth_method: 'none' })
    .expect(201);
  const auth = await request(app).get('/authorize').query({
    client_id: (reg.body as { client_id: string }).client_id,
    response_type: 'code',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    redirect_uri: 'http://localhost:9999/cb',
  });
  return new URL(auth.headers.location as string, BASE).searchParams.get('request_id') ?? '';
}

describe('los titulares salen de la base de datos, no del código', () => {
  it('GET /api/customers devuelve los sembrados', async () => {
    const res = await request(app).get('/api/customers').expect(200);
    const ids = (res.body.customers as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual(['cus_ana', 'cus_luis']);
  });

  it('un titular dado de alta en caliente aparece en /api/customers', async () => {
    insertCustomer('cus_marta', 'Marta Sologuren');
    const res = await request(app).get('/api/customers').expect(200);
    expect(res.body.customers).toContainEqual({ id: 'cus_marta', name: 'Marta Sologuren' });
  });

  it('un titular dado de alta en caliente puede iniciar sesión en la web', async () => {
    insertCustomer('cus_marta', 'Marta Sologuren');
    await request(app).post('/api/login').send({ customerId: 'cus_marta' }).expect(200);
  });

  it('un titular que no está en la base es rechazado', async () => {
    await request(app).post('/api/login').send({ customerId: 'cus_fantasma' }).expect(400);
  });

  it('aparece también en la pantalla de login del consentimiento OAuth', async () => {
    insertCustomer('cus_marta', 'Marta Sologuren');
    const res = await request(app)
      .get('/oauth/consent/login')
      .query({ request_id: await pendingRequestId() })
      .expect(200);
    expect(res.text).toContain('cus_marta');
    expect(res.text).toContain('Marta Sologuren');
  });

  it('el consentimiento muestra el nombre real que hay en la base', async () => {
    insertCustomer('cus_marta', 'Marta Sologuren');
    const requestId = await pendingRequestId();
    const login = await request(app)
      .post('/oauth/consent/login')
      .type('form')
      .send({ request_id: requestId, customer_id: 'cus_marta' })
      .expect(302);
    const page = await request(app)
      .get('/oauth/consent')
      .query({ request_id: requestId })
      .set('Cookie', login.headers['set-cookie'])
      .expect(200);
    expect(page.text).toContain('Marta Sologuren');
  });

  it('el consentimiento OAuth rechaza a quien no está en la base', async () => {
    await request(app)
      .post('/oauth/consent/login')
      .type('form')
      .send({ request_id: await pendingRequestId(), customer_id: 'cus_fantasma' })
      .expect(400);
  });
});

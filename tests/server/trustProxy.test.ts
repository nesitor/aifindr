import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';
import { createCardBlockService } from '../../src/services/cardBlockService.js';
import { DEFAULT_PUBLIC_BASE_URL, resolveTrustProxy } from '../../src/config.js';
import { createApp, isLoopbackHost } from '../../src/server.js';

/**
 * Monta la app real y le añade una ruta sonda que devuelve la IP que Express ha resuelto. Es la
 * única forma de observar el efecto de `trust proxy`: ninguna ruta del gateway expone `req.ip`.
 */
function appWithProbe(trustProxy?: number) {
  const db = openDatabase(':memory:');
  const repos = createRepositories(db);
  seedDatabase(repos, db);
  const service = createCardBlockService({
    repos, now: () => Date.now(), ttlSeconds: 300, publicBaseUrl: 'https://gateway.test',
  });
  const app = createApp({
    service, repos, sessionCookieSecret: 'test-secret',
    publicBaseUrl: 'https://gateway.test', staticDir: null, trustProxy,
  });
  app.get('/__probe', (req, res) => { res.json({ ip: req.ip }); });
  return app;
}

describe('resolveTrustProxy', () => {
  it('sin proxy delante (PUBLIC_BASE_URL por defecto) no confía en ningún salto', () => {
    expect(resolveTrustProxy(DEFAULT_PUBLIC_BASE_URL, undefined)).toBe(0);
  });

  it('con un dominio público (ngrok) confía exactamente en un salto', () => {
    expect(resolveTrustProxy('https://algo.ngrok-free.dev', undefined)).toBe(1);
  });

  it('TRUST_PROXY explícito manda sobre el valor deducido', () => {
    expect(resolveTrustProxy('https://algo.ngrok-free.dev', '2')).toBe(2);
    expect(resolveTrustProxy('https://algo.ngrok-free.dev', '0')).toBe(0);
  });

  it('rechaza un valor que no sea un entero >= 0, en vez de degradar a algo permisivo', () => {
    expect(() => resolveTrustProxy(DEFAULT_PUBLIC_BASE_URL, 'true')).toThrow(/entero/i);
    expect(() => resolveTrustProxy(DEFAULT_PUBLIC_BASE_URL, '-1')).toThrow(/entero/i);
    expect(() => resolveTrustProxy(DEFAULT_PUBLIC_BASE_URL, '1.5')).toThrow(/entero/i);
  });
});

describe('trust proxy en la app', () => {
  it('sin proxy declarado, X-Forwarded-For se ignora por completo', async () => {
    const res = await request(appWithProbe(undefined))
      .get('/__probe')
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(200);
    expect(res.body.ip).not.toBe('203.0.113.9');
  });

  it('con un salto declarado, la IP es la que puso el proxy', async () => {
    const res = await request(appWithProbe(1))
      .get('/__probe')
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(200);
    expect(res.body.ip).toBe('203.0.113.9');
  });

  /**
   * La propiedad que justifica usar un número y no `true`. El atacante controla lo que él mismo
   * envía en X-Forwarded-For, pero el proxy AÑADE su dirección real por la derecha. Confiando en
   * un solo salto, Express se queda con esa última — la que el atacante no puede elegir — así que
   * no puede rotar identidades para saltarse el limitador de /register, /authorize o /token.
   */
  it('un cliente no puede elegir su IP prefijando entradas falsas en X-Forwarded-For', async () => {
    const res = await request(appWithProbe(1))
      .get('/__probe')
      .set('X-Forwarded-For', '1.2.3.4, 5.6.7.8, 203.0.113.9')
      .expect(200);
    expect(res.body.ip).toBe('203.0.113.9');
    expect(res.body.ip).not.toBe('1.2.3.4');
  });

  it('nunca se configura `trust proxy` como booleano true', () => {
    expect(appWithProbe(1).get('trust proxy')).toBe(1);
    expect(appWithProbe(undefined).get('trust proxy')).not.toBe(true);
    expect(appWithProbe(0).get('trust proxy')).not.toBe(true);
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost:3000', 'localhost:3100', 'localhost', '127.0.0.1:8080', '127.1.2.3', '[::1]:3000'])(
    '%s es bucle local, así que nunca se intenta publicar por un túnel',
    (host) => { expect(isLoopbackHost(host)).toBe(true); },
  );

  it.each(['glitzy-hug-angular.ngrok-free.dev', 'gateway.test', 'example.com:443'])(
    '%s sí es un host público',
    (host) => { expect(isLoopbackHost(host)).toBe(false); },
  );
});

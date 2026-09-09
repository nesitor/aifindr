import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories.js';
import { seedDatabase } from '../../src/db/seed.js';
import { createCardBlockService } from '../../src/services/cardBlockService.js';
import { createApp } from '../../src/server.js';

const BASE = 'https://gateway.test';

/**
 * Con SPA montada, que es como corre en producción. Los demás tests usan `staticDir: null`, y por
 * eso no veían que el fallback se estaba tragando rutas de descubrimiento OAuth.
 */
function appWithSpa() {
  const dir = mkdtempSync(join(tmpdir(), 'gw-spa-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>');
  const db = openDatabase(':memory:');
  const repos = createRepositories(db);
  seedDatabase(repos, db);
  const service = createCardBlockService({
    repos, now: () => Date.now(), ttlSeconds: 300, publicBaseUrl: BASE,
  });
  return createApp({
    service, repos, sessionCookieSecret: 'test-secret', publicBaseUrl: BASE, staticDir: dir,
  });
}

let app: ReturnType<typeof createApp>;
beforeEach(() => { app = appWithSpa(); });

describe('descubrimiento OAuth del recurso protegido', () => {
  it('se publica en la ruta con el path del recurso (RFC 9728) y anuncia /mcp, no la raíz', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.resource).toBe(`${BASE}/mcp`);
    expect(res.body.authorization_servers).toContain(`${BASE}/`);
  });

  it('el 401 de /mcp dice dónde está ese metadata, en vez de dejar al cliente adivinar', async () => {
    const res = await request(app).post('/mcp').send({}).expect(401);
    expect(res.headers['www-authenticate']).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('el metadata del servidor de autorización sigue accesible', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(res.body.registration_endpoint).toBe(`${BASE}/register`);
    expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
  });
});

describe('el fallback de la SPA no puede enmascarar rutas de servidor', () => {
  /**
   * El fallo que esto protege: `/.well-known/...` desconocido devolvía el index.html con un 200.
   * Un cliente que pide JSON recibía HTML y no podía distinguir "no existe" de "toma una web".
   */
  it('una ruta desconocida bajo /.well-known da 404, no el HTML de la SPA', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource-inventado');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<title>SPA</title>');
  });

  it.each(['/api/no-existe', '/mcp/no-existe', '/authorize/no-existe', '/oauth/no-existe'])(
    '%s no devuelve la SPA',
    async (path) => {
      const res = await request(app).get(path);
      expect(res.text).not.toContain('<title>SPA</title>');
    },
  );

  it('una petición que no acepta HTML recibe 404 en vez de una página', async () => {
    const res = await request(app).get('/ruta-inventada').set('Accept', 'application/json');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<title>SPA</title>');
  });

  it('pero la SPA se sigue sirviendo a un navegador en cualquier ruta de la app', async () => {
    const res = await request(app).get('/proposals/prop_123').set('Accept', 'text/html').expect(200);
    expect(res.text).toContain('<title>SPA</title>');
  });
});

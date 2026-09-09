export const DEFAULT_PUBLIC_BASE_URL = 'http://localhost:3000';

export interface Config {
  port: number;
  databasePath: string;
  sessionCookieSecret: string;
  proposalTtlSeconds: number;
  publicBaseUrl: string;
  demoMode: boolean;
  /** Número de proxies de confianza delante del gateway. Ver `resolveTrustProxy`. */
  trustProxy: number;
}

/**
 * Cuántos saltos de proxy hay delante de este servidor.
 *
 * Es deliberadamente un NÚMERO y nunca `true`. Con `trust proxy` a `true`, Express se cree la
 * cabecera `X-Forwarded-For` entera venga de donde venga, así que cualquiera puede fabricarla y
 * elegir qué IP ve el servidor. Eso vacía de sentido al limitador de peticiones que el SDK de MCP
 * pone en /authorize, /token, /register y /revoke: bastaría con rotar IPs inventadas para saltárselo.
 * Con un número, Express descarta exactamente esos saltos por la derecha y se queda con la primera
 * dirección que el atacante no controla.
 *
 * Detrás de ngrok hay exactamente un salto. En local no hay ninguno, y ahí conviene dejarlo a 0:
 * sin proxy delante, cualquier `X-Forwarded-For` que llegue es necesariamente falsa.
 */
export function resolveTrustProxy(publicBaseUrl: string, raw = process.env.TRUST_PROXY): number {
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`TRUST_PROXY debe ser un entero >= 0 (recibido: ${raw}).`);
    }
    return n;
  }
  return publicBaseUrl === DEFAULT_PUBLIC_BASE_URL ? 0 : 1;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Copy .env.example to .env.`);
  return value;
}

export function loadConfig(): Config {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL;
  return {
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? './data/gateway.db',
    sessionCookieSecret: required('SESSION_COOKIE_SECRET'),
    proposalTtlSeconds: Number(process.env.PROPOSAL_TTL_SECONDS ?? 300),
    publicBaseUrl,
    demoMode: process.env.DEMO_MODE === 'true',
    trustProxy: resolveTrustProxy(publicBaseUrl),
  };
}

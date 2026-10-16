import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const LOOPBACK_LITERALS = new Set(['127.0.0.1', 'localhost', '::1']);

/** IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is what Node reports for a v6 socket on a v4 peer. */
export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (mapped.startsWith('127.')) return true;
  return LOOPBACK_LITERALS.has(mapped);
}

/** `timingSafeEqual` throws on length mismatch, so the length check has to come first. */
export function tokenEquals(candidate: string, expected: string): boolean {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A non-loopback bind puts every stored key within reach of the network, so starting
 * unauthenticated on such an address is refused outright rather than left to luck.
 */
export function assertAdminBindAllowed(adminHost: string, adminToken: string | null): void {
  if (adminToken || isLoopbackAddress(adminHost)) return;
  throw new Error(
    `[Web] Refusing to bind the admin API to "${adminHost}" without authentication. ` +
      'Set ADMIN_TOKEN to a secret value, or use a loopback ADMIN_HOST (127.0.0.1).'
  );
}

function bearerOf(header: string | undefined): string {
  if (!header) return '';
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .status(401)
    .type('application/json')
    .send(JSON.stringify({ success: false, error: 'Admin token required', code: 'ADMIN_AUTH_REQUIRED' }));
}

/**
 * The gate is all-or-nothing on purpose: a configured `ADMIN_TOKEN` protects every `/api`
 * route, so a missing or wrong token can never be traded for a narrower read. The static
 * renderer sits outside `/api` so the UI itself stays loadable while it asks for a token.
 */
export function createAdminAuthHook(adminToken: string | null) {
  return async function adminAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!adminToken) return;
    if (!request.url.startsWith('/api/')) return;
    if (tokenEquals(bearerOf(request.headers.authorization), adminToken)) return;
    await unauthorized(reply);
  };
}

/**
 * Reveal is the one route that hands out plaintext, so it keeps a peer check even when no
 * token is configured — the default local setup stays usable, a LAN-exposed one does not.
 * Once a token is configured the caller has already proved it, which is the stronger claim.
 */
export function canRevealCredential(
  request: FastifyRequest,
  adminToken: string | null
): { ok: true } | { ok: false; reason: string } {
  if (adminToken) return { ok: true };
  if (isLoopbackAddress(request.ip)) return { ok: true };
  return {
    ok: false,
    reason: `Revealing credentials from ${request.ip} requires ADMIN_TOKEN to be configured`,
  };
}

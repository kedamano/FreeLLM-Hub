import type { FastifyRequest, FastifyReply } from 'fastify';

export function createAuthMiddleware(validTokens: Set<string>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.url === '/health') return;

    const authHeader = request.headers.authorization;

    if (!authHeader) {
      await reply.status(401).send({
        error: { message: 'Missing authorization header', type: 'auth_required' },
      });
      return;
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    if (!validTokens.has(token) && validTokens.size > 0) {
      await reply.status(403).send({
        error: { message: 'Invalid token', type: 'auth_failed' },
      });
    }
  };
}

export function generateAccessToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'fh_';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

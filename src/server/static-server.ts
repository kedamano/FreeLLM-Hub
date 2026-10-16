import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function sendFile(reply: FastifyReply, filePath: string): FastifyReply {
  const content = readFileSync(filePath);
  return reply.type(contentTypeFor(filePath)).send(content);
}

function sendIndex(reply: FastifyReply, indexPath: string): FastifyReply {
  return reply.type('text/html; charset=utf-8').send(readFileSync(indexPath));
}

export function registerStaticRenderer(app: FastifyInstance, rendererDir: string): void {
  const rootDir = resolve(rendererDir);
  const indexPath = join(rootDir, 'index.html');

  const safeResolve = (relative: string): string | null => {
    const target = resolve(rootDir, relative.replace(/^\/+/, ''));
    if (target !== rootDir && !target.startsWith(rootDir + sep)) return null;
    return target;
  };

  app.get('/*', (request: FastifyRequest, reply: FastifyReply) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(request.url.split('?')[0].split('#')[0]);
    } catch {
      return reply.status(400).send({ error: 'Malformed URL' });
    }
    if (urlPath.startsWith('/api/')) {
      return reply.status(404).type('application/json').send(JSON.stringify({ success: false, error: 'Not found' }));
    }

    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const target = safeResolve(relative);
    if (target && existsSync(target)) {
      const stat = statSync(target);
      if (stat.isFile()) return sendFile(reply, target);
    }

    if (existsSync(indexPath)) return sendIndex(reply, indexPath);
    return reply.status(404).send({ error: 'Renderer bundle not found. Run `npm run build` first.' });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api/')) {
      return reply.status(404).type('application/json').send(JSON.stringify({ success: false, error: 'Not found' }));
    }
    if (existsSync(indexPath)) return sendIndex(reply, indexPath);
    return reply.status(404).send({ error: 'Renderer bundle not found. Run `npm run build` first.' });
  });
}

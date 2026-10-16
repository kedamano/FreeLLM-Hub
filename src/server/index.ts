import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAppConfig } from '../core/config/app-config.js';
import { getDatabase, closeDatabase } from '../core/database/database.js';
import { getCredentialStore } from '../main/security/credential-store.js';
import { getProviderRegistry } from '../core/providers/index.js';
import { registerAllProviders, applyPersistedProviderEnabledFromSettings } from '../core/providers/bootstrap.js';
import { readSetting } from '../core/settings/settings-store.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { GatewayManager } from '../main/gateway/gateway-manager.js';
import { registerAdminApi } from './admin-api.js';
import { registerStaticRenderer } from './static-server.js';

const LOOPBACK_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;

function readVersion(): string {
  const projectRoot = resolve(__dirname, '..', '..');
  const pkgPath = join(projectRoot, 'package.json');
  try {
    if (existsSync(pkgPath)) {
      return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

export interface StartServerOptions {
  adminHost?: string;
  adminPort?: number;
  gatewayPort?: number;
  rendererDir?: string;
}

export async function startServer(options: StartServerOptions = {}) {
  const adminHost = options.adminHost ?? process.env.ADMIN_HOST ?? '127.0.0.1';
  const adminPort = options.adminPort ?? Number(process.env.ADMIN_PORT || 3000);
  const gatewayPort = options.gatewayPort ?? Number(process.env.GATEWAY_PORT || 3001);
  const rendererDir =
    options.rendererDir ??
    process.env.RENDERER_DIR ??
    resolve(__dirname, '..', 'renderer');

  const config = getAppConfig();
  console.log(`[Web] Data directory: ${config.dataDir}`);

  getDatabase();
  getCredentialStore();

  const registry = getProviderRegistry();
  registerAllProviders(registry, getCredentialStore());
  applyPersistedProviderEnabledFromSettings(readSetting, registry);

  const scheduler = new Scheduler();
  const gateway = new GatewayManager(scheduler, {
    host: '127.0.0.1',
    port: gatewayPort,
    authEnabled: false,
  });
  gateway.initialize();
  const gatewayResult = await gateway.start();
  if (!gatewayResult.ok) {
    console.error(`[Web] LLM gateway failed to start: ${gatewayResult.error}`);
  }

  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (LOOPBACK_ORIGIN.test(origin)) return callback(null, true);
      callback(null, false);
    },
  });

  await registerAdminApi(app, { scheduler, gateway, version: readVersion() });
  registerStaticRenderer(app, rendererDir);

  await app.listen({ host: adminHost, port: adminPort });
  console.log(`[Web] Admin API + UI listening on http://${adminHost}:${adminPort}`);

  const gatewayUrl = gateway.getGatewayUrl();
  if (gatewayUrl) console.log(`[Web] OpenAI-compatible gateway: ${gatewayUrl}/v1`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[Web] ${signal} received, shutting down...`);
    await app.close().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
    closeDatabase();
    console.log('[Web] Shutdown complete');
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return { app, gateway, scheduler, shutdown: () => shutdown('exit') };
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[Web] Failed to start:', err);
    process.exit(1);
  });
}

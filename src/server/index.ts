import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAppConfig } from '../core/config/app-config.js';
import { getDatabase, closeDatabase } from '../core/database/database.js';
import { flushQueuedWrites } from '../usage/write-buffer.js';
import { getCredentialStore } from '../main/security/credential-store.js';
import { getProviderRegistry } from '../core/providers/index.js';
import { registerAllProviders, applyPersistedProviderEnabledFromSettings } from '../core/providers/bootstrap.js';
import { readProfileSetting, ensureProfilesSeeded } from '../core/settings/profile-store.js';
import { hydrateQuotasFromSettings } from '../main/services/provider-service.js';
import { watchProfileChanges } from '../main/services/profile-service.js';
import { oauthTokenSourceFor, shutdownOAuthFlows } from '../main/services/oauth-service.js';
import { startLogRetentionSchedule } from '../usage/log-retention.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { GatewayManager } from '../main/gateway/gateway-manager.js';
import { registerAdminApi } from './admin-api.js';
import { registerStaticRenderer } from './static-server.js';
import { assertAdminBindAllowed } from './admin-auth.js';

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
  adminToken?: string | null;
}

export interface WebServer {
  app: FastifyInstance;
  gateway: GatewayManager;
  scheduler: Scheduler;
  shutdown: () => Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<WebServer> {
  const adminHost = options.adminHost ?? process.env.ADMIN_HOST ?? '127.0.0.1';
  const adminPort = options.adminPort ?? Number(process.env.ADMIN_PORT || 3000);
  const gatewayPort = options.gatewayPort ?? Number(process.env.GATEWAY_PORT || 3001);
  const rendererDir =
    options.rendererDir ??
    process.env.RENDERER_DIR ??
    resolve(__dirname, '..', 'renderer');

  const adminToken = (options.adminToken ?? process.env.ADMIN_TOKEN ?? '').trim() || null;
  assertAdminBindAllowed(adminHost, adminToken);

  const config = getAppConfig();
  console.log(`[Web] Data directory: ${config.dataDir}`);
  if (adminToken) console.log('[Web] Admin API authentication: enabled (Bearer ADMIN_TOKEN)');

  getDatabase();
  getCredentialStore();
  ensureProfilesSeeded();

  const registry = getProviderRegistry();
  registerAllProviders(registry, getCredentialStore(), { tokenSourceFor: oauthTokenSourceFor });
  applyPersistedProviderEnabledFromSettings(readProfileSetting, registry);

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
      // Token-gated mode is meant to be reachable off-machine, so its own (non-loopback)
      // UI origin has to be allowed; nothing is readable without the bearer token anyway.
      if (adminToken) return callback(null, true);
      callback(null, false);
    },
  });

  const quotaProviders = hydrateQuotasFromSettings(scheduler);
  if (quotaProviders.length > 0) {
    console.log(`[Web] 已加载 ${quotaProviders.length} 个供应商的每日配额配置`);
  }
  const disposeLogRetention = startLogRetentionSchedule();
  // Re-apply the pool whenever the active profile changes (the Admin API can switch it
  // without a restart, and there is no IPC layer in web mode to do it eagerly).
  const disposeProfileWatch = watchProfileChanges(scheduler);

  await registerAdminApi(app, { scheduler, gateway, version: readVersion(), adminToken });
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
    disposeProfileWatch();
    shutdownOAuthFlows();
    disposeLogRetention();
    await app.close().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
    flushQueuedWrites();
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

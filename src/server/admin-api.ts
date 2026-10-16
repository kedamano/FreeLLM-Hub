import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { GatewayManager } from '../main/gateway/gateway-manager.js';
import { redactSecrets } from '../main/security/secret-redaction.js';
import * as providerService from '../main/services/provider-service.js';
import * as modelService from '../main/services/model-service.js';
import * as schedulerService from '../main/services/scheduler-service.js';
import * as settingsService from '../main/services/settings-service.js';
import * as usageService from '../main/services/usage-service.js';
import { getAppConfig } from '../core/config/app-config.js';

export interface AdminApiOptions {
  scheduler: Scheduler;
  gateway: GatewayManager;
  version: string;
}

function sendValue(reply: FastifyReply, value: unknown): FastifyReply {
  return reply.type('application/json').send(JSON.stringify(value ?? null));
}

export async function registerAdminApi(app: FastifyInstance, opts: AdminApiOptions): Promise<void> {
  const { scheduler, gateway, version } = opts;

  // ─── App ───────────────────────────────────────────────────────────
  app.get('/api/app/version', async (_request, reply) => sendValue(reply, version));
  app.get('/api/app/data-path', async (_request, reply) => sendValue(reply, getAppConfig().dataDir));

  // ─── Providers ─────────────────────────────────────────────────────
  app.get('/api/providers', async () => providerService.listProviders(scheduler));

  app.get<{ Params: { id: string } }>('/api/providers/:id', async (request, reply) =>
    sendValue(reply, providerService.getProvider(request.params.id))
  );

  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (request) =>
    providerService.testProvider(request.params.id)
  );

  app.post<{ Params: { id: string }; Body: { credential?: string } }>(
    '/api/providers/:id/credential',
    async (request) => {
      const credential = typeof request.body?.credential === 'string' ? request.body.credential : '';
      return providerService.setProviderCredential(request.params.id, credential);
    }
  );

  app.delete<{ Params: { id: string } }>('/api/providers/:id/credential', async (request) =>
    providerService.removeProviderCredential(request.params.id)
  );

  app.get<{ Params: { id: string } }>('/api/providers/:id/credential', async (request) =>
    providerService.getProviderCredential(request.params.id)
  );

  app.post<{ Body: { name?: string; baseUrl?: string; apiKey?: string } }>(
    '/api/providers/custom',
    async (request) => providerService.createCustomProvider(request.body ?? {})
  );

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request) =>
    providerService.deleteCustomProvider(scheduler, request.params.id)
  );

  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/providers/:id/toggle',
    async (request) => providerService.toggleProvider(scheduler, request.params.id, !!request.body?.enabled)
  );

  app.put<{ Params: { id: string }; Body: { baseUrl?: string } }>(
    '/api/providers/:id/base-url',
    async (request) => providerService.updateProviderBaseUrl(request.params.id, request.body?.baseUrl ?? '')
  );

  app.post<{ Params: { id: string } }>('/api/providers/:id/discover-models', async (request) =>
    providerService.discoverProviderModels(request.params.id)
  );

  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (request) =>
    providerService.getPersistedProviderModels(request.params.id)
  );

  // ─── Models ────────────────────────────────────────────────────────
  app.get('/api/models', async () => modelService.collectModels());

  app.get<{ Params: { providerId: string; modelId: string } }>(
    '/api/models/:providerId/:modelId',
    async (request, reply) => sendValue(reply, await modelService.getModel(request.params.providerId, request.params.modelId))
  );

  app.post('/api/models/discover', async () => modelService.discoverAllModels());
  app.post('/api/models/refresh', async () => modelService.collectModels());

  // ─── Usage ─────────────────────────────────────────────────────────
  app.get('/api/usage/summary', async (_request, reply) => sendValue(reply, usageService.usageDashboard()));

  app.get<{ Querystring: { days?: string } }>('/api/usage/timeseries', async (request) =>
    usageService.usageDailyStats(request.query.days ? Number(request.query.days) : undefined)
  );

  app.get<{ Params: { id: string } }>('/api/usage/providers/:id', async (request) =>
    usageService.usageProviderStats(request.params.id)
  );

  app.get<{ Querystring: { limit?: string } }>('/api/usage/recent', async (request) =>
    usageService.usageRecentCalls(request.query.limit ? Number(request.query.limit) : undefined)
  );

  // ─── Settings ──────────────────────────────────────────────────────
  app.get('/api/settings', async () => settingsService.getAllSettings());

  app.get<{ Params: { key: string } }>('/api/settings/:key', async (request, reply) =>
    sendValue(reply, settingsService.getSetting(request.params.key))
  );

  app.put<{ Params: { key: string }; Body: { value?: string } }>(
    '/api/settings/:key',
    async (request) => settingsService.setSetting(request.params.key, request.body?.value)
  );

  // ─── Scheduler ─────────────────────────────────────────────────────
  app.get('/api/scheduler/status', async () => schedulerService.schedulerStatus(scheduler));

  app.post<{ Body: { providerId?: string } }>('/api/scheduler/reset-circuit', async (request) => {
    if (typeof request.body?.providerId !== 'string') {
      return { success: false, error: 'providerId is required' };
    }
    return schedulerService.resetCircuit(scheduler, request.body.providerId);
  });

  app.post('/api/scheduler/reset-all-circuits', async () => schedulerService.resetAllCircuits(scheduler));

  // ─── Gateway ───────────────────────────────────────────────────────
  app.get('/api/gateway/status', async (_request, reply) => sendValue(reply, gateway.getStatus()));

  app.get('/api/gateway/token', async (_request, reply) => sendValue(reply, gateway.getToken()));

  app.post('/api/gateway/generate-token', async (_request, reply) =>
    sendValue(reply, await gateway.generateToken())
  );

  app.put<{ Body: { host?: string; port?: number; authEnabled?: boolean } }>(
    '/api/gateway/config',
    async (request) => gateway.updateConfig(request.body ?? {})
  );

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;
    reply.status(status).send({
      success: false,
      error: redactSecrets(message),
    });
  });
}

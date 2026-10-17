import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { GatewayManager } from '../main/gateway/gateway-manager.js';
import { redactSecrets } from '../main/security/secret-redaction.js';
import * as providerService from '../main/services/provider-service.js';
import * as modelService from '../main/services/model-service.js';
import * as schedulerService from '../main/services/scheduler-service.js';
import * as settingsService from '../main/services/settings-service.js';
import * as usageService from '../main/services/usage-service.js';
import * as profileService from '../main/services/profile-service.js';
import * as oauthService from '../main/services/oauth-service.js';
import { exportCallLogs, wipeUserData } from '../usage/data-governance.js';
import { getActiveProfileId } from '../core/settings/profile-store.js';
import { getUpdateService } from '../main/services/update-service.js';
import { clampDays, normalizeAuditQuery } from '../usage/audit-query.js';
import { getAppConfig } from '../core/config/app-config.js';
import { canRevealCredential, createAdminAuthHook } from './admin-auth.js';

export interface AdminApiOptions {
  scheduler: Scheduler;
  gateway: GatewayManager;
  version: string;
  /** When set, every `/api` route requires `Authorization: Bearer <token>`. */
  adminToken?: string | null;
}

function sendValue(reply: FastifyReply, value: unknown): FastifyReply {
  return reply.type('application/json').send(JSON.stringify(value ?? null));
}

export async function registerAdminApi(app: FastifyInstance, opts: AdminApiOptions): Promise<void> {
  const { scheduler, gateway, version, adminToken = null } = opts;

  app.addHook('preHandler', createAdminAuthHook(adminToken));

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

  app.get<{ Params: { id: string }; Querystring: { index?: string } }>(
    '/api/providers/:id/credential',
    async (request) =>
      providerService.getProviderCredentialMasked(request.params.id, Number(request.query.index) || 0)
  );

  app.post<{ Params: { id: string }; Body: { index?: number } }>(
    '/api/providers/:id/credential/reveal',
    async (request, reply) => {
      const access = canRevealCredential(request, adminToken);
      if (!access.ok) {
        return reply
          .status(403)
          .type('application/json')
          .send(JSON.stringify({ success: false, error: access.reason }));
      }
      return providerService.getProviderCredential(request.params.id, Number(request.body?.index) || 0);
    }
  );

  app.get<{ Params: { id: string } }>('/api/providers/:id/credentials', async (request) =>
    providerService.listProviderCredentials(request.params.id)
  );

  app.post<{ Params: { id: string }; Body: { credential?: string } }>(
    '/api/providers/:id/credentials',
    async (request) => {
      const credential = typeof request.body?.credential === 'string' ? request.body.credential : '';
      return providerService.addProviderCredential(request.params.id, credential);
    }
  );

  app.delete<{ Params: { id: string; index: string } }>(
    '/api/providers/:id/credentials/:index',
    async (request) =>
      providerService.removeProviderCredentialSlot(request.params.id, Number(request.params.index))
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

  app.put<{ Params: { id: string }; Body: { baseUrl?: string; settings?: Record<string, string> } }>(
    '/api/providers/:id/config',    async (request) =>
      providerService.saveProviderConfig(request.params.id, {
        baseUrl: request.body?.baseUrl,
        settings: request.body?.settings,
      })
  );

  app.put<{ Params: { id: string }; Body: { maxRequestsPerDay?: number; maxTokensPerDay?: number } }>(
    '/api/providers/:id/quota',
    async (request) => providerService.setProviderQuota(scheduler, request.params.id, request.body)
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/providers/:id/oauth',
    async (request) => providerService.configureOAuth(scheduler, request.params.id, request.body)
  );

  app.post<{ Params: { id: string } }>('/api/providers/:id/discover-models', async (request) =>
    providerService.discoverProviderModels(request.params.id)
  );

  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (request) =>
    providerService.getPersistedProviderModels(request.params.id)
  );

  // ─── OAuth ─────────────────────────────────────────────────────────
  app.post<{ Params: { providerId: string } }>(
    '/api/oauth/:providerId/authorize',
    async (request) => oauthService.startAuthorization(request.params.providerId)
  );

  app.get<{ Params: { state: string } }>('/api/oauth/flows/:state', async (_request, reply) =>
    sendValue(reply, oauthService.flowStatus(_request.params.state))
  );

  app.post<{ Params: { state: string } }>('/api/oauth/flows/:state/cancel', async (request) =>
    oauthService.cancelAuthorization(request.params.state)
  );

  app.post<{ Params: { providerId: string } }>(
    '/api/oauth/:providerId/refresh',
    async (request) => oauthService.refreshNow(request.params.providerId)
  );

  app.delete<{ Params: { providerId: string } }>('/api/oauth/:providerId', async (request) =>
    oauthService.unlink(request.params.providerId)
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

  app.get<{ Querystring: { days?: string; profileId?: string } }>(
    '/api/usage/cost',
    async (request) =>
      usageService.usageCostSummary(clampDays(request.query.days, 30), request.query.profileId)
  );

  app.get<{ Querystring: { profileId?: string } }>('/api/usage/quota', async (request) =>
    usageService.usageQuotaUsage(request.query.profileId)
  );

  app.get<{ Querystring: { days?: string; profileId?: string } }>(
    '/api/usage/timeseries-by-provider',
    async (request) =>
      usageService.usageDailyByProvider(
        clampDays(request.query.days, 14),
        request.query.profileId
      )
  );

  // ─── Gateway request audit ────────────────────────────────────────
  app.post<{ Body: unknown }>('/api/audit/list', async (request) =>
    usageService.auditList(normalizeAuditQuery(request.body))
  );

  app.get<{ Querystring: Record<string, string> }>('/api/audit/requests', async (request) =>
    usageService.auditList(normalizeAuditQuery(request.query))
  );

  app.get<{ Params: { requestId: string } }>(
    '/api/audit/requests/:requestId',
    async (request, reply) =>
      sendValue(reply, usageService.auditDetail(request.params.requestId))
  );

  app.post<{ Body: { format?: 'csv' | 'jsonl'; profileId?: string; limit?: number } }>(
    '/api/usage/export',
    async (request, reply) => {
      const format = request.body?.format === 'jsonl' ? 'jsonl' : 'csv';
      const profileId = request.body?.profileId || getActiveProfileId();
      const content = exportCallLogs({ profileId, format, limit: request.body?.limit });
      if (format === 'jsonl') {
        return reply.type('application/x-ndjson').send(content);
      }
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="freellm-hub-calls-${Date.now()}.csv"`)
        .send(content);
    }
  );

  app.post<{ Body: { profileId?: string } }>('/api/usage/wipe', async (request) =>
    wipeUserData(request.body?.profileId)
  );

  // ─── App update (electron-updater; unsupported states answered honestly) ──
  app.post('/api/update/check', async () => getUpdateService().check(true));
  app.post('/api/update/download', async () => getUpdateService().download());
  app.post('/api/update/install', async () => getUpdateService().install());
  app.get('/api/update/state', async () => getUpdateService().getState());
  app.put<{ Body: { enabled?: boolean; autoDownload?: boolean } }>(
    '/api/update/enabled',
    async (request) => {
      const body = request.body ?? {};
      if (typeof body.enabled === 'boolean') getUpdateService().setEnabled(body.enabled);
      if (typeof body.autoDownload === 'boolean') getUpdateService().setAutoDownload(body.autoDownload);
      return getUpdateService().getState();
    }
  );

  app.get<{ Querystring: { days?: string; profileId?: string } }>(
    '/api/audit/summary',
    async (request) =>
      usageService.auditSummary(clampDays(request.query.days, 7), request.query.profileId)
  );

  // ─── Configuration profiles ───────────────────────────────────────
  app.get('/api/profiles', async () => profileService.listProfileViews());
  app.get('/api/profiles/active', async () => profileService.activeProfileView());

  app.get<{ Params: { id: string } }>('/api/profiles/:id', async (request, reply) =>
    sendValue(reply, profileService.getProfileView(request.params.id))
  );

  app.post<{ Body: { name?: string; description?: string; copyFrom?: string } }>(
    '/api/profiles',
    async (request) => profileService.createProfile(request.body ?? {})
  );

  app.put<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/api/profiles/:id',
    async (request) => profileService.renameProfile(request.params.id, request.body ?? {})
  );

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (request) =>
    profileService.removeProfile(request.params.id)
  );

  app.post<{ Params: { id: string } }>('/api/profiles/:id/activate', async (request) =>
    profileService.switchProfile(scheduler, request.params.id)
  );

  app.post<{ Body: { from?: string; to?: string } }>(
    '/api/profiles/duplicate',
    async (request) =>
      profileService.duplicateIntoProfile(String(request.body?.from ?? ''), String(request.body?.to ?? ''))
  );

  app.post<{ Params: { id: string } }>('/api/profiles/:id/reset-pool', async (request) =>
    profileService.resetProfilePool(request.params.id)
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

import { GatewayServer, generateGatewayToken, safeTokenEquals } from './server.js';
import { loggerFor } from '../../core/log/logger.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import { getDatabase } from '../../core/database/database.js';
import { getCredentialStore } from '../security/credential-store.js';
import { deleteSetting, readSetting, writeSetting } from '../../core/settings/settings-store.js';

export interface GatewayConfig {
  host: string;
  port: number;
  authEnabled: boolean;
}

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  host: '127.0.0.1',
  port: 0,
  authEnabled: true,
};

const log = loggerFor('gateway');

const GATEWAY_CONFIG_KEY = 'gateway_config';
const GATEWAY_TOKEN_KEY = 'gateway_token';
const GATEWAY_CREDENTIAL_ID = 'gateway-token';

export interface GatewayStartResult {
  ok: boolean;
  error?: string;
}

export class GatewayManager {
  private gatewayServer: GatewayServer | null = null;
  private gatewayToken: string = '';
  private gatewayStartError: string | null = null;
  private gatewayConfig: GatewayConfig;

  constructor(
    private scheduler: Scheduler,
    defaultConfig: Partial<GatewayConfig> = {}
  ) {
    this.gatewayConfig = { ...DEFAULT_GATEWAY_CONFIG, ...defaultConfig };
  }

  initialize(): void {
    this.loadGatewayConfig();
  }

  private async startGateway(): Promise<GatewayStartResult> {
    try {
      this.gatewayServer = new GatewayServer({
        host: this.gatewayConfig.host,
        port: this.gatewayConfig.port,
        scheduler: this.scheduler,
        authValidator: this.createAuthValidator(),
      });
      const { port } = await this.gatewayServer.start();
      this.gatewayStartError = null;
      log.info(`Listening on http://${this.gatewayConfig.host}:${port}`);

      if (this.gatewayConfig.port === 0) {
        this.gatewayConfig.port = port;
        this.saveGatewayConfig();
      }
      return { ok: true };
    } catch (err) {
      this.gatewayServer = null;
      this.gatewayStartError = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Gateway failed to start');
      return { ok: false, error: this.gatewayStartError };
    }
  }

  async start(): Promise<GatewayStartResult> {
    return this.startGateway();
  }

  async stop(): Promise<void> {
    if (this.gatewayServer) {
      await this.gatewayServer
        .stop()
        .catch((err) => log.error({ err }, 'Gateway failed to stop'));
      this.gatewayServer = null;
    }
  }

  private createAuthValidator(): ((token: string) => boolean) | undefined {
    if (!this.gatewayConfig.authEnabled || !this.gatewayToken) return undefined;
    const validToken = this.gatewayToken;
    return (token: string) => safeTokenEquals(token, validToken);
  }

  // ─── Gateway Configuration ─────────────────────────────────────────

  private loadGatewayConfig(): void {
    try {
      const row = readSetting(GATEWAY_CONFIG_KEY);
      if (row) {
        const parsed = JSON.parse(row) as Partial<GatewayConfig>;
        this.gatewayConfig = {
          host: typeof parsed.host === 'string' && LOOPBACK_HOSTS.has(parsed.host) ? parsed.host : this.gatewayConfig.host,
          port:
            typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port >= 0 && parsed.port <= 65535
              ? parsed.port
              : this.gatewayConfig.port,
          authEnabled:
            typeof parsed.authEnabled === 'boolean' ? parsed.authEnabled : this.gatewayConfig.authEnabled,
        };
      }
    } catch {
      this.gatewayConfig = { ...this.gatewayConfig };
    }

    if (!this.gatewayToken) {
      this.gatewayToken = this.readStoredToken();
    }

    if (this.gatewayConfig.authEnabled && !this.gatewayToken) {
      this.gatewayToken = generateGatewayToken();
      this.saveGatewayConfig();
    }
  }

  private readStoredToken(): string {
    try {
      const store = getCredentialStore();
      const stored = store.retrieve(GATEWAY_CREDENTIAL_ID);
      if (stored) return stored;

      const db = getDatabase();
      const legacy = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(GATEWAY_TOKEN_KEY) as { value: string } | undefined;
      if (legacy?.value) {
        const token = legacy.value;
        try {
          store.store(GATEWAY_CREDENTIAL_ID, token);
        } catch {
          log.error('Failed to migrate gateway token to the secure store');
        }
        deleteSetting(GATEWAY_TOKEN_KEY);
        return token;
      }
    } catch (err) {
      log.error({ err }, 'Unable to read gateway token securely');
    }
    return '';
  }

  private saveGatewayConfig(): void {
    try {
      writeSetting(GATEWAY_CONFIG_KEY, JSON.stringify(this.gatewayConfig));
      if (this.gatewayToken) {
        try {
          getCredentialStore().store(GATEWAY_CREDENTIAL_ID, this.gatewayToken);
        } catch (err) {
          log.error(
            { err },
            'Secure storage unavailable; gateway token kept in memory only'
          );
        }
      }
    } catch (err) {
      log.error({ err }, 'Failed to save gateway config');
    }
  }

  getGatewayConfig(): GatewayConfig {
    return { ...this.gatewayConfig };
  }

  getGatewayUrl(): string {
    if (!this.gatewayServer) return '';
    return this.gatewayServer.getUrl();
  }

  getGatewayServer(): GatewayServer | null {
    return this.gatewayServer;
  }

  getStatus() {
    const runtime = this.gatewayServer?.getStatus();
    return {
      running: !!runtime?.running,
      host: this.gatewayConfig.host,
      port: runtime?.running ? runtime.port : this.gatewayConfig.port,
      url: runtime?.running ? runtime.url : '',
      authEnabled: this.gatewayConfig.authEnabled,
      hasToken: !!this.gatewayToken,
      lastError: runtime?.lastError ?? this.gatewayStartError,
    };
  }

  getToken(): string {
    return this.gatewayToken;
  }

  async generateToken(): Promise<string> {
    this.gatewayToken = generateGatewayToken();
    this.saveGatewayConfig();
    if (this.gatewayServer) {
      const restartError = await this.restart();
      if (restartError) {
        log.error({ restartError }, 'Gateway restart after token rotation failed');
      }
    }
    return this.gatewayToken;
  }

  async updateConfig(config: Partial<GatewayConfig>) {
    const previous = { ...this.gatewayConfig };

    if (config.host !== undefined) {
      if (typeof config.host !== 'string' || !LOOPBACK_HOSTS.has(config.host)) {
        return {
          success: false,
          error: `Gateway host must be one of: ${[...LOOPBACK_HOSTS].join(', ')}`,
          config: this.getGatewayConfig(),
        };
      }
      this.gatewayConfig.host = config.host;
    }

    if (config.port !== undefined) {
      const port = Number(config.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return {
          success: false,
          error: 'Port must be an integer between 0 and 65535',
          config: this.getGatewayConfig(),
        };
      }
      this.gatewayConfig.port = port;
    }

    if (config.authEnabled !== undefined) {
      this.gatewayConfig.authEnabled = !!config.authEnabled;
    }

    if (this.gatewayConfig.authEnabled && !this.gatewayToken) {
      this.gatewayToken = generateGatewayToken();
    }

    this.saveGatewayConfig();

    const needsRestart =
      previous.host !== this.gatewayConfig.host ||
      previous.port !== this.gatewayConfig.port ||
      previous.authEnabled !== this.gatewayConfig.authEnabled ||
      !this.gatewayServer;

    const restartError = needsRestart ? await this.restart() : null;

    return {
      success: !restartError,
      error: restartError ?? undefined,
      config: this.getGatewayConfig(),
      status: this.getStatus(),
    };
  }

  async restart(): Promise<string | null> {
    await this.stop();
    const result = await this.startGateway();
    return result.ok ? null : (result.error ?? 'Gateway restart failed');
  }
}

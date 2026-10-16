import { app } from 'electron';
import { WindowManager } from './window-manager.js';
import { TrayManager } from './tray-manager.js';
import { GatewayServer, generateGatewayToken, safeTokenEquals } from './gateway/server.js';
import { getDatabase, closeDatabase } from '../core/database/database.js';
import { getCredentialStore } from './security/credential-store.js';
import { registerAllIpcHandlers } from './ipc/index.js';
import { registerIpcHandler } from './ipc/handle.js';
import { deleteSetting, readSetting, writeSetting } from './ipc/settings.ipc.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { getProviderRegistry } from '../core/providers/index.js';
import {
  createOllamaAdapter,
  createLMStudioAdapter,
  createGroqAdapter,
  createGoogleGeminiAdapter,
  createCloudflareAdapter,
  createHuggingFaceAdapter,
  createCerebrasAdapter,
  createSiliconFlowAdapter,
  createNvidiaAdapter,
  createOpenRouterAdapter,
  createModelScopeAdapter,
  createSenseNovaAdapter,
} from '../core/providers/index.js';
import { getAppConfig } from '../core/config/app-config.js';

export interface GatewayConfig {
  host: string;
  port: number;
  authEnabled: boolean;
}

const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  host: '127.0.0.1',
  port: 0,
  authEnabled: true,
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const GATEWAY_CONFIG_KEY = 'gateway_config';
const GATEWAY_TOKEN_KEY = 'gateway_token';
const GATEWAY_CREDENTIAL_ID = 'gateway-token';

export class AppLifecycle {
  private windowManager = new WindowManager();
  private trayManager = new TrayManager();
  private gatewayServer: GatewayServer | null = null;
  private scheduler: Scheduler;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownComplete = false;
  private gatewayToken: string = '';
  private gatewayStartError: string | null = null;
  private gatewayConfig: GatewayConfig = { ...DEFAULT_GATEWAY_CONFIG };

  constructor() {
    this.scheduler = new Scheduler();
  }

  async initialize(): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      console.log('[App] Running in development mode');
    }

    const config = getAppConfig();
    console.log(`[App] Data directory: ${config.dataDir}`);

    getDatabase();
    getCredentialStore();

    this.loadGatewayConfig();

    this.registerProviders();
    this.setupSecondInstance();
    registerAllIpcHandlers(this.scheduler, this.windowManager, this.gatewayServer);

    this.registerGatewayIpc();
  }

  async ready(): Promise<void> {
    this.windowManager.createMainWindow();

    await this.startGateway();

    this.trayManager.createTray({
      onShow: () => this.windowManager.showMainWindow(),
      onHide: () => this.windowManager.hideMainWindow(),
      onQuit: () => app.quit(),
    });
  }

  private async startGateway(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.gatewayServer = new GatewayServer({
        host: this.gatewayConfig.host,
        port: this.gatewayConfig.port,
        scheduler: this.scheduler,
        authValidator: this.createAuthValidator(),
      });
      const { port } = await this.gatewayServer.start();
      this.gatewayStartError = null;
      console.log(`[Gateway] Listening on http://${this.gatewayConfig.host}:${port}`);

      if (this.gatewayConfig.port === 0) {
        this.gatewayConfig.port = port;
        this.saveGatewayConfig();
      }
      return { ok: true };
    } catch (err) {
      this.gatewayServer = null;
      this.gatewayStartError = err instanceof Error ? err.message : String(err);
      console.error('[Gateway] Failed to start:', this.gatewayStartError);
      return { ok: false, error: this.gatewayStartError };
    }
  }

  private createAuthValidator(): ((token: string) => boolean) | undefined {
    if (!this.gatewayConfig.authEnabled || !this.gatewayToken) return undefined;
    const validToken = this.gatewayToken;
    return (token: string) => safeTokenEquals(token, validToken);
  }

  private registerProviders(): void {
    const registry = getProviderRegistry();

    const credentialStore = getCredentialStore();

    const ollamaKey = 'ollama-config';
    let ollamaBaseUrl = 'http://localhost:11434';
    const ollamaConfig = credentialStore.retrieve(ollamaKey);
    if (ollamaConfig) {
      try {
        const parsed = JSON.parse(ollamaConfig);
        if (parsed.baseUrl) ollamaBaseUrl = parsed.baseUrl;
      } catch {
        console.warn('[Lifecycle] Invalid ollama config in credential store');
      }
    }

    registry.register(createOllamaAdapter({ baseUrl: ollamaBaseUrl }));
    registry.register(createLMStudioAdapter());

    const groqKey = credentialStore.retrieve('groq-key');
    registry.register(createGroqAdapter(groqKey || undefined));

    const googleKey = credentialStore.retrieve('google-key');
    registry.register(createGoogleGeminiAdapter(googleKey || undefined));

    const cfToken = credentialStore.retrieve('cloudflare-token');
    const cfAccount = credentialStore.retrieve('cloudflare-account');
    registry.register(createCloudflareAdapter(cfAccount || undefined, cfToken || undefined));

    const hfToken = credentialStore.retrieve('huggingface-token');
    registry.register(createHuggingFaceAdapter(hfToken || undefined));

    const cerebrasKey = credentialStore.retrieve('cerebras-key');
    registry.register(createCerebrasAdapter(cerebrasKey || undefined));

    const siliconflowKey = credentialStore.retrieve('siliconflow-key');
    registry.register(createSiliconFlowAdapter(siliconflowKey || undefined));

    const nvidiaKey = credentialStore.retrieve('nvidia-key');
    registry.register(createNvidiaAdapter(nvidiaKey || undefined));

    const openrouterKey = credentialStore.retrieve('openrouter-key');
    registry.register(createOpenRouterAdapter(openrouterKey || undefined));

    const modelscopeKey = credentialStore.retrieve('modelscope-key');
    registry.register(createModelScopeAdapter(modelscopeKey || undefined));

    const sensenovaKey = credentialStore.retrieve('sensenova-key');
    registry.register(createSenseNovaAdapter(sensenovaKey || undefined));

    console.log(`[Providers] Registered ${registry.getAll().length} providers`);
  }

  private setupSecondInstance(): void {
    app.on('second-instance', () => {
      this.windowManager.showMainWindow();
    });
  }

  // ─── Gateway Configuration ─────────────────────────────────────────

  private loadGatewayConfig(): void {
    try {
      const row = readSetting(GATEWAY_CONFIG_KEY);
      if (row) {
        const parsed = JSON.parse(row) as Partial<GatewayConfig>;
        this.gatewayConfig = {
          host: typeof parsed.host === 'string' && LOOPBACK_HOSTS.has(parsed.host) ? parsed.host : DEFAULT_GATEWAY_CONFIG.host,
          port:
            typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port >= 0 && parsed.port <= 65535
              ? parsed.port
              : DEFAULT_GATEWAY_CONFIG.port,
          authEnabled:
            typeof parsed.authEnabled === 'boolean' ? parsed.authEnabled : DEFAULT_GATEWAY_CONFIG.authEnabled,
        };
      }
    } catch {
      this.gatewayConfig = { ...DEFAULT_GATEWAY_CONFIG };
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
          console.error('[Gateway] Failed to migrate token to secure store');
        }
        deleteSetting(GATEWAY_TOKEN_KEY);
        return token;
      }
    } catch (err) {
      console.error('[Gateway] Unable to read token securely:', err);
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
          console.error('[Gateway] Secure storage unavailable; token kept in memory only:', err);
        }
      }
    } catch (err) {
      console.error('[Gateway] Failed to save config:', err);
    }
  }

  getGatewayConfig(): GatewayConfig {
    return { ...this.gatewayConfig };
  }

  getGatewayUrl(): string {
    if (!this.gatewayServer) return '';
    return this.gatewayServer.getUrl();
  }

  private gatewayStatus() {
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

  // ─── IPC for Gateway ───────────────────────────────────────────────

  private registerGatewayIpc(): void {
    registerIpcHandler('gateway:getStatus', async () => this.gatewayStatus());

    registerIpcHandler('gateway:getToken', async () => this.gatewayToken);

    registerIpcHandler('gateway:generateToken', async () => {
      this.gatewayToken = generateGatewayToken();
      this.saveGatewayConfig();
      if (this.gatewayServer) {
        const restartError = await this.restartGateway();
        if (restartError) console.error('[Gateway] Restart after token rotation failed:', restartError);
      }
      return this.gatewayToken;
    });

    registerIpcHandler('gateway:updateConfig', async (_e, config: Partial<GatewayConfig>) => {
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

      const restartError = needsRestart ? await this.restartGateway() : null;

      return {
        success: !restartError,
        error: restartError ?? undefined,
        config: this.getGatewayConfig(),
        status: this.gatewayStatus(),
      };
    });
  }

  private async restartGateway(): Promise<string | null> {
    if (this.gatewayServer) {
      await this.gatewayServer.stop().catch(() => undefined);
      this.gatewayServer = null;
    }

    const result = await this.startGateway();
    return result.ok ? null : (result.error ?? 'Gateway restart failed');
  }

  isShutdownComplete(): boolean {
    return this.shutdownComplete;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      console.log('[App] Shutting down...');

      if (this.gatewayServer) {
        await this.gatewayServer.stop().catch((err) => console.error('[Gateway] Failed to stop:', err));
        this.gatewayServer = null;
      }

      this.trayManager.destroy();
      this.windowManager.destroyMainWindow();
      closeDatabase();

      this.shutdownComplete = true;
      console.log('[App] Shutdown complete');
    })();

    return this.shutdownPromise;
  }

  getWindowManager(): WindowManager {
    return this.windowManager;
  }

  getScheduler(): Scheduler {
    return this.scheduler;
  }

  getGatewayServer(): GatewayServer | null {
    return this.gatewayServer;
  }
}

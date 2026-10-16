import { app, ipcMain } from 'electron';
import { WindowManager } from './window-manager.js';
import { TrayManager } from './tray-manager.js';
import { GatewayServer, generateGatewayToken } from './gateway/server.js';
import { getDatabase, closeDatabase } from '../core/database/database.js';
import { getCredentialStore } from './security/credential-store.js';
import { registerAllIpcHandlers } from './ipc/index.js';
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
} from '../core/providers/index.js';
import { getAppConfig } from '../core/config/app-config.js';

export interface GatewayConfig {
  host: string;
  port: number;
  authEnabled: boolean;
  token: string;
}

const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  host: '127.0.0.1',
  port: 0,
  authEnabled: false,
  token: '',
};

export class AppLifecycle {
  private windowManager = new WindowManager();
  private trayManager = new TrayManager();
  private gatewayServer: GatewayServer | null = null;
  private scheduler: Scheduler;
  private isQuitting = false;
  private gatewayToken: string = '';
  private gatewayConfig: GatewayConfig = DEFAULT_GATEWAY_CONFIG;

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

    // Load gateway config from settings
    this.loadGatewayConfig();

    this.registerProviders();
    this.setupSingleInstance();
    registerAllIpcHandlers(this.scheduler, this.windowManager, this.gatewayServer);

    // Register gateway IPC handlers
    this.registerGatewayIpc();
  }

  async ready(): Promise<void> {
    this.windowManager.createMainWindow();

    try {
      // Build auth validator if enabled and token exists
      let authValidator: ((token: string) => boolean) | undefined;
      if (this.gatewayConfig.authEnabled && this.gatewayToken) {
        const validToken = this.gatewayToken;
        authValidator = (token: string) => token === validToken;
        console.log('[Gateway] Authentication enabled');
      }

      this.gatewayServer = new GatewayServer({
        host: this.gatewayConfig.host,
        port: this.gatewayConfig.port,
        scheduler: this.scheduler,
        authValidator,
      });
      const { port } = await this.gatewayServer.start();
      console.log(`[Gateway] Listening on http://127.0.0.1:${port}`);

      // Update config with actual port (in case port=0 was used)
      if (this.gatewayConfig.port === 0) {
        this.gatewayConfig.port = port;
        this.saveGatewayConfig();
      }
    } catch (err) {
      console.error('[Gateway] Failed to start:', err);
    }

    this.trayManager.createTray({
      onShow: () => this.windowManager.showMainWindow(),
      onHide: () => this.windowManager.hideMainWindow(),
      onQuit: () => this.quit(),
    });
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
      } catch {}
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

    console.log(`[Providers] Registered ${registry.getAll().length} providers`);
  }

  private setupSingleInstance(): void {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return;
    }

    app.on('second-instance', () => {
      this.windowManager.showMainWindow();
    });
  }

  // ─── Gateway Configuration ─────────────────────────────────────────

  private loadGatewayConfig(): void {
    try {
      const db = getDatabase();
      const row = db.prepare("SELECT value FROM settings WHERE key = 'gateway_config'").get() as
        | { value: string }
        | undefined;
      if (row) {
        this.gatewayConfig = JSON.parse(row.value);
      }
    } catch {
      this.gatewayConfig = { ...DEFAULT_GATEWAY_CONFIG };
    }

    // Load token (if not in config)
    if (!this.gatewayToken) {
      try {
        const db = getDatabase();
        const row = db.prepare("SELECT value FROM settings WHERE key = 'gateway_token'").get() as
          | { value: string }
          | undefined;
        if (row) this.gatewayToken = row.value;
      } catch {}
    }

    // If auth is enabled but no token, generate one
    if (this.gatewayConfig.authEnabled && !this.gatewayToken) {
      this.gatewayToken = generateGatewayToken();
      this.saveGatewayConfig();
    }
  }

  private saveGatewayConfig(): void {
    try {
      const db = getDatabase();
      const configToSave = { ...this.gatewayConfig, token: '' };
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      ).run('gateway_config', JSON.stringify(configToSave));
      if (this.gatewayToken) {
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
        ).run('gateway_token', this.gatewayToken);
      }
    } catch (err) {
      console.error('[Gateway] Failed to save config:', err);
    }
  }

  getGatewayConfig(): GatewayConfig {
    return { ...this.gatewayConfig, token: this.gatewayToken };
  }

  getGatewayUrl(): string {
    if (!this.gatewayServer) return '';
    return `http://${this.gatewayConfig.host}:${this.gatewayServer.getPort()}`;
  }

  // ─── IPC for Gateway ───────────────────────────────────────────────

  private registerGatewayIpc(): void {
    ipcMain.handle('gateway:getStatus', () => {
      const port = this.gatewayServer?.getPort() || this.gatewayConfig.port;
      const host = this.gatewayConfig.host;
      return {
        running: !!this.gatewayServer,
        host,
        port,
        url: this.gatewayServer ? `http://${host}:${port}` : '',
        authEnabled: this.gatewayConfig.authEnabled,
        hasToken: !!this.gatewayToken,
      };
    });

    ipcMain.handle('gateway:getToken', () => {
      return this.gatewayToken;
    });

    ipcMain.handle('gateway:generateToken', () => {
      this.gatewayToken = generateGatewayToken();
      this.saveGatewayConfig();
      return this.gatewayToken;
    });

    ipcMain.handle('gateway:updateConfig', (_e, config: Partial<GatewayConfig>) => {
      const oldHost = this.gatewayConfig.host;
      const oldPort = this.gatewayConfig.port;
      const oldAuth = this.gatewayConfig.authEnabled;

      if (config.host !== undefined) this.gatewayConfig.host = config.host;
      if (config.port !== undefined) this.gatewayConfig.port = config.port;
      if (config.authEnabled !== undefined) this.gatewayConfig.authEnabled = config.authEnabled;

      // Generate token if enabling auth without one
      if (this.gatewayConfig.authEnabled && !this.gatewayToken) {
        this.gatewayToken = generateGatewayToken();
      }

      this.saveGatewayConfig();

      // Restart gateway if host/port/auth changed
      if (
        this.gatewayServer &&
        (oldHost !== this.gatewayConfig.host ||
          oldPort !== this.gatewayConfig.port ||
          oldAuth !== this.gatewayConfig.authEnabled)
      ) {
        this.restartGateway();
      }

      return { success: true, config: this.getGatewayConfig() };
    });
  }

  private async restartGateway(): Promise<void> {
    if (this.gatewayServer) {
      await this.gatewayServer.stop();
    }

    let authValidator: ((token: string) => boolean) | undefined;
    if (this.gatewayConfig.authEnabled && this.gatewayToken) {
      const validToken = this.gatewayToken;
      authValidator = (token: string) => token === validToken;
    }

    this.gatewayServer = new GatewayServer({
      host: this.gatewayConfig.host,
      port: this.gatewayConfig.port,
      scheduler: this.scheduler,
      authValidator,
    });

    const { port } = await this.gatewayServer.start();
    if (this.gatewayConfig.port === 0) {
      this.gatewayConfig.port = port;
      this.saveGatewayConfig();
    }
    console.log(`[Gateway] Restarted on ${this.gatewayConfig.host}:${port}`);
  }

  async quit(): Promise<void> {
    if (this.isQuitting) return;
    this.isQuitting = true;

    console.log('[App] Shutting down...');

    if (this.gatewayServer) {
      await this.gatewayServer.stop();
    }

    this.trayManager.destroy();
    this.windowManager.destroyMainWindow();
    closeDatabase();

    app.quit();
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

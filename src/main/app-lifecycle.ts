import { app, ipcMain } from 'electron';
import { WindowManager } from './window-manager.js';
import { TrayManager } from './tray-manager.js';
import { GatewayServer } from './gateway/server.js';
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

export class AppLifecycle {
  private windowManager = new WindowManager();
  private trayManager = new TrayManager();
  private gatewayServer: GatewayServer | null = null;
  private scheduler: Scheduler;
  private isQuitting = false;

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

    this.registerProviders();
    this.setupSingleInstance();
    registerAllIpcHandlers(this.scheduler, this.windowManager, this.gatewayServer);
  }

  async ready(): Promise<void> {
    this.windowManager.createMainWindow();

    try {
      this.gatewayServer = new GatewayServer({
        host: '127.0.0.1',
        port: 0,
        scheduler: this.scheduler,
      });
      const { port } = await this.gatewayServer.start();
      console.log(`[Gateway] Listening on http://127.0.0.1:${port}`);
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

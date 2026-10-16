import { app } from 'electron';
import { WindowManager } from './window-manager.js';
import { TrayManager } from './tray-manager.js';
import { GatewayManager } from './gateway/gateway-manager.js';
import { closeDatabase, getDatabase } from '../core/database/database.js';
import { getCredentialStore } from './security/credential-store.js';
import { registerAllIpcHandlers } from './ipc/index.js';
import { registerIpcHandler } from './ipc/handle.js';
import { readSetting } from './ipc/settings.ipc.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { getProviderRegistry } from '../core/providers/index.js';
import { registerAllProviders, applyPersistedProviderEnabledFromSettings } from '../core/providers/bootstrap.js';
import { hydrateQuotasFromSettings } from './services/provider-service.js';
import { startLogRetentionSchedule } from '../usage/log-retention.js';
import { getAppConfig } from '../core/config/app-config.js';

export type { GatewayConfig } from './gateway/gateway-manager.js';

export class AppLifecycle {
  private windowManager = new WindowManager();
  private trayManager = new TrayManager();
  private scheduler: Scheduler;
  private gatewayManager: GatewayManager;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownComplete = false;
  private disposeLogRetention: () => void = () => {};

  constructor() {
    this.scheduler = new Scheduler();
    this.gatewayManager = new GatewayManager(this.scheduler);
  }

  async initialize(): Promise<void> {
    if (process.env.NODE_ENV === 'development') {
      console.log('[App] Running in development mode');
    }

    const config = getAppConfig();
    console.log(`[App] Data directory: ${config.dataDir}`);

    getDatabase();
    getCredentialStore();

    this.gatewayManager.initialize();

    this.registerProviders();
    const quotaProviders = hydrateQuotasFromSettings(this.scheduler);
    if (quotaProviders.length > 0) {
      console.log(`[App] 已加载 ${quotaProviders.length} 个供应商的每日配额配置`);
    }
    this.disposeLogRetention = startLogRetentionSchedule();
    this.setupSecondInstance();
    registerAllIpcHandlers(this.scheduler, this.windowManager, this.gatewayManager.getGatewayServer());

    this.registerGatewayIpc();
  }

  async ready(): Promise<void> {
    this.windowManager.createMainWindow();

    await this.gatewayManager.start();

    this.trayManager.createTray({
      onShow: () => this.windowManager.showMainWindow(),
      onHide: () => this.windowManager.hideMainWindow(),
      onQuit: () => app.quit(),
    });
  }

  private registerProviders(): void {
    registerAllProviders(getProviderRegistry(), getCredentialStore());
  }

  private setupSecondInstance(): void {
    app.on('second-instance', () => {
      this.windowManager.showMainWindow();
    });
  }

  // ─── IPC for Gateway ───────────────────────────────────────────────

  private registerGatewayIpc(): void {
    registerIpcHandler('gateway:getStatus', async () => this.gatewayManager.getStatus());

    registerIpcHandler('gateway:getToken', async () => this.gatewayManager.getToken());

    registerIpcHandler('gateway:generateToken', async () => this.gatewayManager.generateToken());

    registerIpcHandler('gateway:updateConfig', async (_e, config) =>
      this.gatewayManager.updateConfig(config)
    );
  }

  applyPersistedProviderEnabled(): void {
    applyPersistedProviderEnabledFromSettings(readSetting);
  }

  isShutdownComplete(): boolean {
    return this.shutdownComplete;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      console.log('[App] Shutting down...');

      this.disposeLogRetention();
      await this.gatewayManager.stop();

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

  getGatewayServer() {
    return this.gatewayManager.getGatewayServer();
  }
}

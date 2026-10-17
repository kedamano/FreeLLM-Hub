import { app } from 'electron';
import { WindowManager } from './window-manager.js';
import { TrayManager } from './tray-manager.js';
import { GatewayManager } from './gateway/gateway-manager.js';
import { closeDatabase, getDatabase } from '../core/database/database.js';
import { flushQueuedWrites } from '../usage/write-buffer.js';
import { getCredentialStore } from './security/credential-store.js';
import { registerAllIpcHandlers } from './ipc/index.js';
import { registerIpcHandler } from './ipc/handle.js';
import { readProfileSetting, writeProfileSetting, ensureProfilesSeeded } from '../core/settings/profile-store.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { getProviderRegistry } from '../core/providers/index.js';
import { registerAllProviders, applyPersistedProviderEnabledFromSettings } from '../core/providers/bootstrap.js';
import { hydrateQuotasFromSettings } from './services/provider-service.js';
import { startLogRetentionSchedule } from '../usage/log-retention.js';
import { oauthTokenSourceFor } from './services/oauth-service.js';
import { getUpdateService, type UpdateState } from './services/update-service.js';
import { getAppConfig } from '../core/config/app-config.js';
import { HealthProbe } from '../scheduler/health-probe.js';
import { notify as systemNotify } from './services/update-service.js';
import { startBudgetChecks } from '../usage/budget-service.js';
import { getActiveProfileId } from '../core/settings/profile-store.js';

export type { GatewayConfig } from './gateway/gateway-manager.js';

export class AppLifecycle {
  private windowManager = new WindowManager();
  private trayManager = new TrayManager();
  private scheduler: Scheduler;
  private gatewayManager: GatewayManager;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownComplete = false;
  private disposeLogRetention: () => void = () => {};
  private disposeUpdateChecks: () => void = () => {};
  private disposeHealthProbe: () => void = () => {};
  private disposeBudgetChecks: () => void = () => {};

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
    // Materialise the `default` profile row before anything reads profile state.
    ensureProfilesSeeded();

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

    const updater = getUpdateService();
    this.trayManager.createTray({
      onShow: () => this.windowManager.showMainWindow(),
      onHide: () => this.windowManager.hideMainWindow(),
      onQuit: () => app.quit(),
      onCheckUpdate: () => {
        void this.runUpdateCheck(true);
      },
      onInstallUpdate: () => {
        this.trayManager.setUpdateStatus({ busy: false });
        updater.install();
      },
    });
    this.publishUpdateState(updater.getState());
    this.disposeUpdateChecks = updater.startAutoCheck();
    // Staggered so a window open and a gateway bind are not competing with a feed
    // request on first paint; the interval handler covers the long-running case.
    setTimeout(() => void this.runUpdateCheck(false), 8000);

    this.startHealthProbe();
    this.disposeBudgetChecks = startBudgetChecks(() => getActiveProfileId(), {
      readSetting: (key) => {
        try {
          return readProfileSetting(key);
        } catch {
          return null;
        }
      },
      writeSetting: (key, value) => {
        try {
          writeProfileSetting(key, value);
        } catch {
          /* settings table not ready */
        }
      },
    });
  }

  /**
   * Background provider probing: catches dead providers before a user request does.
   * Transitions (down / recovered) surface as system notifications - a provider going
   * dark is exactly the kind of thing the user wants to know without opening the app.
   */
  private startHealthProbe(): void {
    const registry = getProviderRegistry();
    const probe = new HealthProbe({
      targets: () =>
        registry
          .getAll()
          .filter((adapter) => adapter.getProviderConfig().isEnabled)
          .map((adapter) => ({
            providerId: adapter.providerId,
            isAvailable: () => adapter.isAvailable(),
          })),
      onTransition: (result) => {
        const name = registry.get(result.providerId)?.providerName ?? result.providerId;
        if (result.transition === 'down') {
          systemNotify('服务商探活失败', `${name} 连续探活失败，已从候选池暂时降权`);
        } else if (result.transition === 'recovered') {
          systemNotify('服务商已恢复', `${name} 探活恢复正常`);
        }
      },
    });
    this.disposeHealthProbe = probe.start();
  }

  /** Manual (tray) or startup auto-check; both funnel the result back into the menu. */
  private async runUpdateCheck(manual: boolean): Promise<UpdateState | null> {
    const updater = getUpdateService();
    if (!manual && !updater.isEnabled()) return null;
    this.trayManager.setUpdateStatus({ busy: true });
    const state = await updater.check(manual);
    this.publishUpdateState(state);
    return state;
  }

  private publishUpdateState(state: UpdateState): void {
    // The renderer has no update UI yet, so the tray is the only surface: an in-flight
    // state must grey the item, and a downloaded package must offer the restart.
    const busy = state.phase === 'checking' || state.phase === 'downloading';
    this.trayManager.setUpdateStatus({
      busy,
      readyVersion: state.phase === 'ready' ? state.version : null,
      availableVersion: state.phase === 'available' ? state.version : null,
    });
    if (state.phase === 'available' || state.phase === 'downloading') {
      // Follow the download to its end so the menu flips to "重启并安装更新".
      setTimeout(() => this.publishUpdateState(getUpdateService().getState()), 4000);
    }
  }

  private registerProviders(): void {
    registerAllProviders(getProviderRegistry(), getCredentialStore(), {
      tokenSourceFor: oauthTokenSourceFor,
    });
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
    applyPersistedProviderEnabledFromSettings(readProfileSetting);
  }

  isShutdownComplete(): boolean {
    return this.shutdownComplete;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      console.log('[App] Shutting down...');

      this.disposeUpdateChecks();
      this.disposeBudgetChecks();
      this.disposeHealthProbe();
      this.disposeLogRetention();
      await this.gatewayManager.stop();

      // Drain the write buffer before the connection goes away.
      flushQueuedWrites();
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

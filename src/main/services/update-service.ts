import type { Notification as ElectronNotification } from 'electron';

/**
 * Application self-update.
 *
 * Kept as a plain class over an injected `UpdaterLike` so the whole state machine is
 * unit-testable without Electron, without a network feed, and without ever calling
 * `quitAndInstall` in a test run. The Electron wiring lives in `createElectronUpdater()`
 * and is loaded lazily, because `electron-updater` expects a real packaged app.
 *
 * Flow: idle -> checking -> (not-available | available -> downloading -> ready) -> install.
 */

export const AUTO_UPDATE_ENABLED_KEY = 'auto_update_enabled';
export const AUTO_UPDATE_DOWNLOAD_KEY = 'auto_update_download';
export const LAST_AUTO_CHECK_KEY = 'auto_update_last_check';

/** Auto checks are rate limited so restarting the app does not hammer the feed. */
export const MIN_AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported';

export interface UpdateState {
  phase: UpdatePhase;
  /** Version of the pending update, when one exists. */
  version: string | null;
  /** 0-100 while downloading. */
  percent: number | null;
  error: string | null;
  currentVersion: string;
  enabled: boolean;
  autoDownload: boolean;
  checkedAt: string | null;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isImmediate: boolean): void;
  on(event: 'update-available', listener: (info: { version: string }) => void): void;
  on(event: 'update-not-available', listener: () => void): void;
  on(event: 'download-progress', listener: (info: { percent: number }) => void): void;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): void;
  on(event: 'error', listener: (err: unknown) => void): void;
}

export interface UpdateServiceDeps {
  /** Null when running unpackaged or where self-update is unavailable. */
  createUpdater: () => UpdaterLike | null;
  currentVersion: string;
  readSetting: (key: string) => string | null;
  writeSetting: (key: string, value: string) => void;
  notify: (title: string, body: string) => void;
  now: () => number;
}

const boolSetting = (raw: string | null, fallback: boolean): boolean =>
  raw === 'true' ? true : raw === 'false' ? false : fallback;

export class UpdateService {
  private updater: UpdaterLike | null | undefined;
  private state: UpdateState;
  private pendingVersion: string | null = null;

  constructor(private deps: UpdateServiceDeps) {
    this.state = {
      phase: 'idle',
      version: null,
      percent: null,
      error: null,
      currentVersion: deps.currentVersion,
      enabled: boolSetting(deps.readSetting(AUTO_UPDATE_ENABLED_KEY), true),
      autoDownload: boolSetting(deps.readSetting(AUTO_UPDATE_DOWNLOAD_KEY), true),
      checkedAt: deps.readSetting(LAST_AUTO_CHECK_KEY),
    };
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.state.enabled = enabled;
    this.deps.writeSetting(AUTO_UPDATE_ENABLED_KEY, enabled ? 'true' : 'false');
  }

  /** When false, an available update is announced but not fetched until asked. */
  setAutoDownload(enabled: boolean): void {
    this.state.autoDownload = enabled;
    this.deps.writeSetting(AUTO_UPDATE_DOWNLOAD_KEY, enabled ? 'true' : 'false');
  }

  private ensureUpdater(): UpdaterLike | null {
    if (this.updater !== undefined) return this.updater;
    this.updater = this.deps.createUpdater();
    if (this.updater) this.bind(this.updater);
    if (!this.updater && this.state.phase === 'idle') this.state.phase = 'unsupported';
    return this.updater;
  }

  private bind(updater: UpdaterLike): void {
    // Downloads are always started by this service, never implicitly by electron-updater,
    // so the app stays in control of bandwidth (a full installer is ~80-110 MB).
    updater.autoDownload = false;
    // "Install on quit" is the safe default; the tray additionally offers an immediate
    // restart so the user is never stuck on a downloaded-but-unapplied update.
    updater.autoInstallOnAppQuit = true;

    updater.on('update-available', (info) => {
      this.pendingVersion = info.version;
      this.state.version = info.version;
      this.state.phase = 'available';
      this.state.error = null;
      this.state.percent = null;
      this.stampCheck();
      this.deps.notify('发现新版本', `FreeLLM Hub ${info.version} 准备就绪`);
      if (this.state.autoDownload) void this.download();
    });

    updater.on('update-not-available', () => {
      this.state.phase = 'not-available';
      this.state.percent = null;
      this.stampCheck();
    });

    updater.on('download-progress', (info) => {
      this.state.phase = 'downloading';
      this.state.percent = Math.min(100, Math.max(0, Math.round(Number(info?.percent) || 0)));
    });

    updater.on('update-downloaded', (info) => {
      this.state.phase = 'ready';
      this.state.percent = 100;
      this.state.version = info?.version ?? this.pendingVersion;
      this.deps.notify('更新已就绪', `重启后使用 FreeLLM Hub ${this.state.version ?? ''}（托盘菜单可立即重启）`);
    });

    updater.on('error', (err) => {
      this.state.phase = 'error';
      this.state.error = err instanceof Error ? err.message : String(err);
      this.stampCheck();
      console.warn('[Update] 更新检查失败:', this.state.error);
    });
  }

  private stampCheck(): void {
    const iso = new Date(this.deps.now()).toISOString();
    this.state.checkedAt = iso;
    this.deps.writeSetting(LAST_AUTO_CHECK_KEY, iso);
  }

  /**
   * @param manual true when the user asked for it (tray / settings), which bypasses both
   *               the master switch and the rate limit.
   */
  async check(manual = false): Promise<UpdateState> {
    if (!manual && !this.state.enabled) return this.getState();

    const updater = this.ensureUpdater();
    if (!updater) {
      this.state.phase = 'unsupported';
      return this.getState();
    }
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') {
      return this.getState();
    }
    if (!manual && this.recentlyChecked()) return this.getState();

    this.state.phase = 'checking';
    this.state.error = null;
    this.state.percent = null;
    try {
      await updater.checkForUpdates();
      // The available / not-available events carry the real outcome. If the feed
      // resolved without firing either one, settle back to idle: leaving `checking`
      // in place would wedge the machine, because every later check short-circuits
      // on the "already checking" guard and the user could never retry manually.
      if (this.state.phase === 'checking') {
        this.state.phase = 'idle';
        this.state.percent = null;
      }
      this.stampCheck();
    } catch (err) {
      this.state.phase = 'error';
      this.state.error = err instanceof Error ? err.message : String(err);
      this.stampCheck();
    }
    return this.getState();
  }

  private recentlyChecked(): boolean {
    const last = this.state.checkedAt ? Date.parse(this.state.checkedAt) : NaN;
    if (!Number.isFinite(last)) return false;
    return this.deps.now() - last < MIN_AUTO_CHECK_INTERVAL_MS;
  }

  async download(): Promise<UpdateState> {
    const updater = this.ensureUpdater();
    if (!updater) return this.getState();
    if (this.state.phase === 'downloading' || this.state.phase === 'ready') return this.getState();
    if (this.state.phase !== 'available' && this.state.phase !== 'error') return this.getState();

    this.state.phase = 'downloading';
    this.state.percent = 0;
    this.state.error = null;
    try {
      await updater.downloadUpdate();
    } catch (err) {
      this.state.phase = 'error';
      this.state.error = err instanceof Error ? err.message : String(err);
    }
    return this.getState();
  }

  canInstall(): boolean {
    return this.state.phase === 'ready';
  }

  install(): UpdateState {
    const updater = this.ensureUpdater();
    if (!updater || this.state.phase !== 'ready') return this.getState();
    // electron-updater terminates the process; nothing after this point runs.
    updater.quitAndInstall(true, true);
    return this.getState();
  }

  /** Periodic auto-check. Returns a dispose function for shutdown paths. */
  startAutoCheck(intervalMs: number = DEFAULT_AUTO_CHECK_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      if (this.state.enabled) void this.check(false);
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }
}

// ─── Electron wiring ─────────────────────────────────────────────────

let service: UpdateService | null = null;

function isPackagedRuntime(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app: { isPackaged: boolean } };
    return app.isPackaged === true;
  } catch {
    return false;
  }
}

/** Lazily bound real updater; `electron-updater` only makes sense in a packaged app. */
export function createElectronUpdater(): UpdaterLike | null {
  if (!isPackagedRuntime()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as { autoUpdater: UpdaterLike };
    return autoUpdater;
  } catch (err) {
    console.warn(
      '[Update] electron-updater 不可用:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export function notify(title: string, body: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Notification } = require('electron') as {
      Notification: typeof ElectronNotification & { isSupported(): boolean };
    };
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    /* notifications are a nicety, never a requirement */
  }
}

/** Settings are reached lazily so this module loads before the database exists. */
function settingsBridge(): {
  readSetting: (key: string) => string | null;
  writeSetting: (key: string, value: string) => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../core/settings/settings-store.js') as {
    readSetting: (key: string) => string | null;
    writeSetting: (key: string, value: string) => void;
  };
}

export function getUpdateService(
  overrides: Partial<UpdateServiceDeps> = {}
): UpdateService {
  if (service) return service;
  let currentVersion = '0.0.0';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app: { getVersion(): string } };
    currentVersion = app.getVersion() || currentVersion;
  } catch {
    /* dev or test runtime */
  }
  service = new UpdateService({
    createUpdater: createElectronUpdater,
    currentVersion,
    readSetting: (key) => {
      try {
        return settingsBridge().readSetting(key);
      } catch {
        return null;
      }
    },
    writeSetting: (key, value) => {
      try {
        settingsBridge().writeSetting(key, value);
      } catch {
        /* settings table not ready yet */
      }
    },
    notify,
    now: () => Date.now(),
    ...overrides,
  });
  return service;
}

export function resetUpdateService(): void {
  service = null;
}

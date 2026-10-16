import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AUTO_UPDATE_DOWNLOAD_KEY,
  AUTO_UPDATE_ENABLED_KEY,
  LAST_AUTO_CHECK_KEY,
  MIN_AUTO_CHECK_INTERVAL_MS,
  UpdateService,
  type UpdaterLike,
} from '../../src/main/services/update-service';

/** Updater double: tests drive the events the way electron-updater would. */
class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '9.9.9' } }));
  downloadUpdate = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();

  private listeners = new Map<string, Array<(payload: never) => void>>();

  on(event: string, listener: (payload: never) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (p: unknown) => void)(payload);
    }
  }
}

let updater: FakeUpdater;
let settings: Map<string, string>;
let notifications: Array<{ title: string; body: string }>;
let clock: number;
let service: UpdateService;

function buildService(overrides: { createUpdater?: () => UpdaterLike | null } = {}) {
  return new UpdateService({
    createUpdater: overrides.createUpdater ?? (() => updater),
    currentVersion: '0.1.0',
    readSetting: (key) => settings.get(key) ?? null,
    writeSetting: (key, value) => settings.set(key, value),
    notify: (title, body) => notifications.push({ title, body }),
    now: () => clock,
  });
}

beforeEach(() => {
  updater = new FakeUpdater();
  settings = new Map();
  notifications = [];
  clock = Date.parse('2026-10-17T02:00:00.000Z');
  service = buildService();
});

describe('update state machine', () => {
  it('walks available -> downloading -> ready and reports progress', async () => {
    // Auto-download is on by default, so this service instance observes the download
    // immediately; use a switch-off instance to pin down the intermediate state.
    service.setAutoDownload(false);

    // A feed that resolves without firing any event settles back to idle rather than
    // staying stuck in `checking`.
    const settled = await service.check(true);
    expect(settled.phase).toBe('idle');
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    updater.emit('update-available', { version: '0.2.0' });
    const available = service.getState();
    expect(available.phase).toBe('available');
    expect(available.version).toBe('0.2.0');

    updater.emit('download-progress', { percent: 42.7 });
    expect(service.getState()).toMatchObject({ phase: 'downloading', percent: 43 });

    updater.emit('update-downloaded', { version: '0.2.0' });
    expect(service.getState()).toMatchObject({ phase: 'ready', percent: 100, version: '0.2.0' });
    expect(service.canInstall()).toBe(true);
  });

  it('takes over the download instead of letting the updater start it', () => {
    expect(updater.autoDownload).toBe(true);
    service.getState();
    // The first check binds the updater; assert the override happens there.
    return service.check(true).then(() => {
      expect(updater.autoDownload).toBe(false);
      expect(updater.autoInstallOnAppQuit).toBe(true);
    });
  });

  it('downloads automatically once an update is available', async () => {
    await service.check(true);
    updater.emit('update-available', { version: '0.2.0' });
    await Promise.resolve();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('announces but does not download when auto-download is off', async () => {
    service.setAutoDownload(false);
    await service.check(true);
    updater.emit('update-available', { version: '0.2.0' });
    await Promise.resolve();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(notifications[0]?.title).toBe('发现新版本');

    // A later explicit download still works.
    await service.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('persists both switches so the choice survives a restart', async () => {
    service.setEnabled(false);
    service.setAutoDownload(false);
    expect(settings.get(AUTO_UPDATE_ENABLED_KEY)).toBe('false');
    expect(settings.get(AUTO_UPDATE_DOWNLOAD_KEY)).toBe('false');

    const reopened = buildService();
    expect(reopened.getState()).toMatchObject({ enabled: false, autoDownload: false });
  });

  it('reports not-available without leaving a pending version behind', async () => {
    await service.check(true);
    updater.emit('update-not-available');
    expect(service.getState()).toMatchObject({ phase: 'not-available', version: null });
    expect(settings.get(LAST_AUTO_CHECK_KEY)).toBeTruthy();
  });

  it('records an error and can retry the same check', async () => {
    await service.check(true);
    updater.emit('error', new Error('feed unreachable'));
    expect(service.getState()).toMatchObject({ phase: 'error', error: 'feed unreachable' });

    await service.check(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('does not report install capability before a package exists', () => {
    expect(service.canInstall()).toBe(false);
    updater.emit('update-available', { version: '0.2.0' });
    expect(service.canInstall()).toBe(false);
    service.install();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('quits and installs only for a verified download', async () => {
    await service.check(true);
    updater.emit('update-available', { version: '0.2.0' });
    updater.emit('update-downloaded', { version: '0.2.0' });
    service.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});

describe('auto-check gating', () => {
  it('skips the background check when the master switch is off', async () => {
    service.setEnabled(false);
    await service.check(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    // A manual check still runs: the switch governs background traffic only.
    await service.check(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('rate limits background checks to one per interval', async () => {
    await service.check(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    await service.check(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    clock += MIN_AUTO_CHECK_INTERVAL_MS + 1000;
    await service.check(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('reads a persisted last-check timestamp on construction', () => {
    settings.set(
      LAST_AUTO_CHECK_KEY,
      new Date(clock - 60_000).toISOString()
    );
    const reopened = buildService();
    return reopened.check(false).then(() => {
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  it('reports unsupported rather than throwing when there is no updater', async () => {
    const none = buildService({ createUpdater: () => null });
    const state = await none.check(true);
    expect(state.phase).toBe('unsupported');
    expect(none.canInstall()).toBe(false);
  });

  it('ignores concurrent checks while one is in flight', async () => {
    let releaseCheck: (() => void) | undefined;
    updater.checkForUpdates = vi.fn(
      () =>
        new Promise<{ updateInfo: { version: string } }>((resolve) => {
          releaseCheck = () => resolve({ updateInfo: { version: '0.2.0' } });
        })
    );
    const first = service.check(true);
    const second = await service.check(true);
    expect(second.phase).toBe('checking');
    releaseCheck?.();
    await first;
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected feed as an error state, never a crash', async () => {
    updater.checkForUpdates = vi.fn(async () => {
      throw new Error('ENOTFOUND releases.githubusercontent');
    });
    const state = await service.check(true);
    expect(state).toMatchObject({ phase: 'error', error: expect.stringContaining('ENOTFOUND') });
  });

  it('startAutoCheck returns a working dispose', () => {
    vi.useFakeTimers();
    const dispose = service.startAutoCheck(1000);
    vi.advanceTimersByTime(2500);
    dispose();
    const after = updater.checkForUpdates.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(updater.checkForUpdates.mock.calls.length).toBe(after);
    vi.useRealTimers();
  });
});

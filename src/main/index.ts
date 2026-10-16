import { app } from 'electron';
import { AppLifecycle } from './app-lifecycle.js';
import { isWebModeRequested, runWebMode } from './web-mode.js';

if (process.platform === 'win32') {
  // Must match `appId` in electron-builder.yml, otherwise Windows notifications and the
  // taskbar jump list are attributed to a different application identity.
  app.setAppUserModelId('com.freellmhub.app');
}

const webMode = isWebModeRequested();
const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  if (webMode) {
    // The desktop app owns the same data directory and ports, so a headless start cannot
    // proceed and must not look like a successful run.
    console.error('[Web] 已有 FreeLLM Hub 实例在运行（桌面窗口或另一个 --web 进程），本次启动中止。');
    app.exit(1);
  } else {
    console.log('[App] Another instance already owns the single-instance lock');
    app.quit();
  }
}

/** Null in `--web` mode: no window, no tray, no IPC. */
let lifecycle: AppLifecycle | null = null;

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  try {
    if (webMode) {
      await runWebMode();
      return;
    }
    lifecycle = new AppLifecycle();
    await lifecycle.initialize();
    await lifecycle.ready();
  } catch (err) {
    console.error('[App] Failed to start:', err);
    // A headless server that failed to bind has nothing left to show the error in.
    if (webMode) app.exit(1);
  }
});

app.on('window-all-closed', () => {
  // Keep app running in tray on Windows
});

app.on('before-quit', (event) => {
  if (!isPrimaryInstance || !lifecycle || lifecycle.isShutdownComplete()) return;

  event.preventDefault();
  lifecycle
    .shutdown()
    .then(() => app.exit(0))
    .catch((err) => {
      console.error('[App] Shutdown failed:', err);
      app.exit(1);
    });
});

app.on('activate', () => {
  if (!isPrimaryInstance || !lifecycle) return;
  lifecycle.getWindowManager().showMainWindow();
});

process.on('unhandledRejection', (reason) => {
  console.error('[App] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[App] Uncaught exception:', err);
});

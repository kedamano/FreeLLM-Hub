import { app } from 'electron';
import { AppLifecycle } from './app-lifecycle.js';

if (process.platform === 'win32') {
  app.setAppUserModelId('com.freellm-hub.app');
}

const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  console.log('[App] Another instance already owns the single-instance lock');
  app.quit();
}

const lifecycle = new AppLifecycle();

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  try {
    await lifecycle.initialize();
    await lifecycle.ready();
  } catch (err) {
    console.error('[App] Failed to start:', err);
  }
});

app.on('window-all-closed', () => {
  // Keep app running in tray on Windows
});

app.on('before-quit', (event) => {
  if (!isPrimaryInstance || lifecycle.isShutdownComplete()) return;

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
  if (!isPrimaryInstance) return;
  lifecycle.getWindowManager().showMainWindow();
});

process.on('unhandledRejection', (reason) => {
  console.error('[App] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[App] Uncaught exception:', err);
});

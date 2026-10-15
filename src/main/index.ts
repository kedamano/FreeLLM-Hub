import { app } from 'electron';
import { AppLifecycle } from './app-lifecycle.js';

if (process.platform === 'win32') {
  app.setAppUserModelId('com.freellm-hub.app');
}

const lifecycle = new AppLifecycle();

app.whenReady().then(async () => {
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

app.on('before-quit', async () => {
  await lifecycle.quit();
});

app.on('activate', () => {
  lifecycle.getWindowManager().showMainWindow();
});

process.on('unhandledRejection', (reason) => {
  console.error('[App] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[App] Uncaught exception:', err);
});

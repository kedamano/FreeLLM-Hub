import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import { resolve } from 'node:path';
import { getAppConfig } from '../core/config/app-config.js';

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;

  createMainWindow(): BrowserWindow {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      return this.mainWindow;
    }

    const { isDev } = getAppConfig();

    const options: BrowserWindowConstructorOptions = {
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 600,
      title: 'FreeLLM Hub',
      backgroundColor: '#f8fafc',
      webPreferences: {
        preload: resolve(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
      show: false,
    };

    this.mainWindow = new BrowserWindow(options);

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show();
    });

    this.mainWindow.on('close', (event) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        event.preventDefault();
        this.mainWindow.hide();
      }
    });

    if (isDev) {
      this.mainWindow.loadURL('http://localhost:5173');
    } else {
      this.mainWindow.loadFile(resolve(__dirname, '../renderer/index.html'));
    }

    return this.mainWindow;
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  showMainWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
    } else {
      this.createMainWindow();
    }
  }

  hideMainWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.hide();
    }
  }

  destroyMainWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.removeAllListeners();
      this.mainWindow.destroy();
    }
    this.mainWindow = null;
  }

  sendToRenderer(channel: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args);
    }
  }
}

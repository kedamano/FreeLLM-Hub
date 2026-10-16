import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron';
import { resolve } from 'node:path';
import { getAppConfig } from '../core/config/app-config.js';

const DEV_SERVER_ORIGIN = 'http://localhost:5173';

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
    this.applyNavigationGuards(this.mainWindow, isDev);

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
      this.mainWindow.loadURL(DEV_SERVER_ORIGIN);
    } else {
      this.mainWindow.loadFile(resolve(__dirname, '../renderer/index.html'));
    }

    return this.mainWindow;
  }

  private applyNavigationGuards(win: BrowserWindow, isDev: boolean): void {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url).catch(() => undefined);
      }
      return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowedNavigation(url, isDev)) {
        event.preventDefault();
        console.warn(`[Window] Blocked navigation to ${url}`);
      }
    });
  }

  private isAllowedNavigation(url: string, isDev: boolean): boolean {
    try {
      const target = new URL(url);
      if (isDev && target.origin === DEV_SERVER_ORIGIN) return true;
      if (!isDev && target.protocol === 'file:') return true;
      return false;
    } catch {
      return false;
    }
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

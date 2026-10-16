import { Tray, Menu, nativeImage } from 'electron';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface TrayCallbacks {
  onShow: () => void;
  onHide: () => void;
  onQuit: () => void;
  /** Self-update actions; omitted when the build has no update feed. */
  onCheckUpdate?: () => void;
  onInstallUpdate?: () => void;
}

export interface TrayUpdateStatus {
  /** Set while a check or download is in flight, to grey the item out. */
  busy?: boolean;
  /** Present once an update package has been downloaded and verified. */
  readyVersion?: string | null;
  /** Version discovered but not yet downloaded, shown as a hint. */
  availableVersion?: string | null;
}

export class TrayManager {
  private tray: Tray | null = null;
  private callbacks: TrayCallbacks | null = null;
  private updateStatus: TrayUpdateStatus = {};

  createTray(callbacks: TrayCallbacks): void {
    if (this.tray) return;

    // tray.png is the asset generated for this purpose (see scripts/gen-icons.mjs);
    // the .ico stays in the chain as a fallback for older checkouts.
    const candidates = [
      resolve(__dirname, '../../resources/icons/tray.png'),
      resolve(__dirname, '../../resources/icons/icon.ico'),
    ];
    const iconPath = candidates.find((path) => existsSync(path));
    let icon: Electron.NativeImage;

    if (iconPath) {
      icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) console.warn(`[Tray] 图标无法解码: ${iconPath}`);
    } else {
      console.warn(`[Tray] 未找到托盘图标，已使用空白图标: ${candidates.join(', ')}`);
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip('FreeLLM Hub - 大模型聚合管理平台');
    this.setContextMenu(callbacks);

    this.tray.on('click', () => {
      callbacks.onShow();
    });
  }

  setContextMenu(callbacks: TrayCallbacks): void {
    if (!this.tray) return;
    this.callbacks = callbacks;
    this.rebuildMenu();
  }

  /**
   * Reflect the updater state in the tray. The renderer still has no update UI, so
   * the tray is where "检查更新" and "重启并安装更新" live; without this the user
   * would have no way to apply a downloaded update other than quitting the app.
   */
  setUpdateStatus(status: TrayUpdateStatus): void {
    this.updateStatus = status;
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    if (!this.tray || !this.callbacks) return;
    const callbacks = this.callbacks;
    const status = this.updateStatus;

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'FreeLLM Hub', enabled: false },
      { type: 'separator' },
      {
        label: '显示主窗口',
        click: () => callbacks.onShow(),
      },
    ];

    if (status.readyVersion) {
      template.push({
        label: `重启并安装更新 ${status.readyVersion}`,
        click: () => callbacks.onInstallUpdate?.(),
      });
    } else if (callbacks.onCheckUpdate) {
      template.push({
        label: status.busy ? '检查更新中…' : '检查更新…',
        enabled: !status.busy,
        click: () => callbacks.onCheckUpdate?.(),
      });
    }

    template.push({ type: 'separator' });
    template.push({
      label: '退出',
      click: () => callbacks.onQuit(),
    });

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

import { Tray, Menu, nativeImage } from 'electron';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface TrayCallbacks {
  onShow: () => void;
  onHide: () => void;
  onQuit: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;

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

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'FreeLLM Hub', enabled: false },
      { type: 'separator' },
      {
        label: '显示主窗口',
        click: () => callbacks.onShow(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => callbacks.onQuit(),
      },
    ];

    const contextMenu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(contextMenu);
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

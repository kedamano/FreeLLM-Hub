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

    const iconPath = resolve(__dirname, '../../resources/icons/tray.png');
    let icon: Electron.NativeImage;

    if (existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
    } else {
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

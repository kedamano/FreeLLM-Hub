import { getDatabase } from '../../core/database/database.js';

export function registerSettingsIpc(): void {
  const { ipcMain } = require('electron');

  ipcMain.handle('settings:get', async (_event, key: string) => {
    const db = getDatabase();
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  });

  ipcMain.handle('settings:set', async (_event, key: string, value: string) => {
    const db = getDatabase();
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    );
    stmt.run(key, value);
    return { success: true };
  });

  ipcMain.handle('settings:get-all', async () => {
    const db = getDatabase();
    const stmt = db.prepare('SELECT key, value FROM settings');
    const rows = stmt.all() as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  });

  ipcMain.handle('app:version', async () => {
    return '0.1.0';
  });

  ipcMain.handle('app:data-path', async () => {
    const { getAppConfig } = require('../../core/config/app-config.js');
    return getAppConfig().dataDir;
  });
}

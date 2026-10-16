import { getDatabase } from '../../core/database/database.js';
import { registerIpcHandler } from './handle.js';

const EDITABLE_SETTINGS_KEYS = new Set<string>([
  'theme',
  'language',
  'launch_at_startup',
  'notifications_enabled',
  'compact_mode',
  'default_task_type',
  'log_level',
  'first_run_complete',
]);

const RESERVED_PREFIXES = ['gateway_', 'provider-enabled:', 'credential'];

function isEditableKey(key: unknown): key is string {
  return typeof key === 'string' && EDITABLE_SETTINGS_KEYS.has(key);
}

function isReserved(key: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function registerSettingsIpc(): void {
  registerIpcHandler('settings:get', async (_e, key: string) => {
    if (!isEditableKey(key)) return null;
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  });

  registerIpcHandler('settings:set', async (_e, key: string, value: string) => {
    if (!isEditableKey(key)) {
      return { success: false, error: `Setting key is not allowed: ${String(key)}` };
    }
    if (typeof value !== 'string') {
      return { success: false, error: 'Setting value must be a string' };
    }
    const db = getDatabase();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(key, value);
    return { success: true };
  });

  registerIpcHandler('settings:get-all', async () => {
    const db = getDatabase();
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (isReserved(row.key) || !EDITABLE_SETTINGS_KEYS.has(row.key)) continue;
      result[row.key] = row.value;
    }
    return result;
  });
}

export function readSetting(key: string): string | null {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).run(key, value);
}

export function deleteSetting(key: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

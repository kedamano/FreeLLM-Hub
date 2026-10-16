import { getDatabase } from '../database/database.js';

export const EDITABLE_SETTINGS_KEYS = new Set<string>([
  'theme',
  'language',
  'launch_at_startup',
  'notifications_enabled',
  'compact_mode',
  'default_task_type',
  'log_level',
  'first_run_complete',
]);

export const RESERVED_PREFIXES = ['gateway_', 'provider-enabled:', 'credential'];

export function isEditableKey(key: unknown): key is string {
  return typeof key === 'string' && EDITABLE_SETTINGS_KEYS.has(key);
}

export function isReserved(key: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
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

export function readAllSettings(): Record<string, string> {
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
}

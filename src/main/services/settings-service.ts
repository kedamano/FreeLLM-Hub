import {
  isEditableKey,
  readSetting,
  writeSetting,
  readAllSettings,
} from '../../core/settings/settings-store.js';

export function getSetting(key: unknown): string | null {
  if (!isEditableKey(key)) return null;
  return readSetting(key);
}

export function setSetting(
  key: unknown,
  value: unknown
): { success: boolean; error?: string } {
  if (!isEditableKey(key)) {
    return { success: false, error: `Setting key is not allowed: ${String(key)}` };
  }
  if (typeof value !== 'string') {
    return { success: false, error: 'Setting value must be a string' };
  }
  writeSetting(key, value);
  return { success: true };
}

export function getAllSettings(): Record<string, string> {
  return readAllSettings();
}

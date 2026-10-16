import { registerIpcHandler } from './handle.js';
import {
  EDITABLE_SETTINGS_KEYS,
  isEditableKey,
  readSetting,
  readAllSettings,
  writeSetting,
  deleteSetting,
} from '../../core/settings/settings-store.js';

export { readSetting, writeSetting, deleteSetting };

export function registerSettingsIpc(): void {
  registerIpcHandler('settings:get', async (_e, key: string) => {
    if (!isEditableKey(key)) return null;
    return readSetting(key);
  });

  registerIpcHandler('settings:set', async (_e, key: string, value: string) => {
    if (!isEditableKey(key)) {
      return { success: false, error: `Setting key is not allowed: ${String(key)}` };
    }
    if (typeof value !== 'string') {
      return { success: false, error: 'Setting value must be a string' };
    }
    writeSetting(key, value);
    return { success: true };
  });

  registerIpcHandler('settings:get-all', async () => readAllSettings());
}

export function isAllowedSettingKey(key: unknown): key is string {
  return isEditableKey(key);
}

export { EDITABLE_SETTINGS_KEYS };

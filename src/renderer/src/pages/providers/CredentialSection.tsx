import type { CredentialSlot, ProviderInfo } from './types';

export interface CredentialForm {
  apiKey: string;
  showKey: boolean;
  savedKeys: CredentialSlot[];
  revealedKeys: Record<number, string>;
  backupInput: string;
  addingBackup: boolean;
}

export interface CredentialActions {
  onChange: (value: string) => void;
  onChangeBackup: (value: string) => void;
  onToggleReveal: () => Promise<void> | void;
  onSave: () => Promise<void>;
  onRemove: () => Promise<void>;
  onAddBackup: () => Promise<void>;
  onRemoveSlot: (index: number) => Promise<void>;
  onRevealSlot: (index: number) => Promise<void>;
}

interface CredentialSectionProps {
  provider: ProviderInfo;
  saving: boolean;
  form: CredentialForm;
  actions: CredentialActions;
}

/** The page writes this into the field while a stored key is hidden, so it must not be saved back. */
export const MASKED_KEY = '••••••••••••';

/**
 * Primary key, the saved key pool the scheduler rotates through when one is rate limited,
 * and the field for adding another. Local providers have no key at all and skip this block.
 */
export default function CredentialSection({
  provider,
  saving,
  form,
  actions,
}: CredentialSectionProps) {
  return (
    <div className="mb-5">
      <label className="label">{provider.authType === 'oauth' ? 'OAuth Token' : 'API Key'}</label>
      <div className="flex gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            type={form.showKey ? 'text' : 'password'}
            value={form.apiKey}
            onChange={(e) => actions.onChange(e.target.value)}
            placeholder="输入 API Key 或 Token"
            className="input-field pr-10 font-mono text-xs"
          />
          <button
            type="button"
            onClick={actions.onToggleReveal}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 text-xs"
          >
            {form.showKey ? '隐藏' : '显示'}
          </button>
        </div>
        <button
          onClick={actions.onSave}
          disabled={saving || !form.apiKey || form.apiKey === MASKED_KEY}
          className="btn-primary text-xs shrink-0"
        >
          {provider.hasCredential ? '更新' : '保存'}
        </button>
        {provider.hasCredential && (
          <button onClick={actions.onRemove} className="btn-danger text-xs shrink-0">
            清除
          </button>
        )}
      </div>

      {form.savedKeys.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[11px] text-surface-400">已保存的 Key（限流 / 失效时自动轮换）</div>
          {form.savedKeys.map((k) => (
            <div
              key={k.keyId}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-surface-50 border border-surface-100"
            >
              <span className="text-[10px] font-semibold text-surface-500 shrink-0">
                Key {k.index + 1}
                {k.index === 0 ? '（主）' : ''}
              </span>
              <span className="flex-1 text-xs font-mono text-surface-600 truncate">
                {form.revealedKeys[k.index] ?? k.masked}
              </span>
              <button
                type="button"
                onClick={() => actions.onRevealSlot(k.index)}
                className="text-[11px] text-surface-400 hover:text-surface-600 shrink-0"
              >
                {form.revealedKeys[k.index] !== undefined ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                onClick={() => actions.onRemoveSlot(k.index)}
                className="text-[11px] text-red-400 hover:text-red-600 shrink-0"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          type="password"
          value={form.backupInput}
          onChange={(e) => actions.onChangeBackup(e.target.value)}
          placeholder="添加备用 Key（可选）"
          className="input-field flex-1 min-w-0 font-mono text-xs"
        />
        <button
          onClick={actions.onAddBackup}
          disabled={form.addingBackup || !form.backupInput.trim()}
          className="btn-secondary text-xs shrink-0"
        >
          {form.addingBackup ? '添加中…' : '＋ 添加备用'}
        </button>
      </div>
    </div>
  );
}

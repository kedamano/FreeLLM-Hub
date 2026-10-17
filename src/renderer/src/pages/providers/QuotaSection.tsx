import type { ProviderInfo } from './types';

export interface QuotaForm {
  requests: string;
  tokens: string;
}

interface QuotaSectionProps {
  provider: ProviderInfo;
  saving: boolean;
  form: QuotaForm;
  onChange: (field: 'requests' | 'tokens', value: string) => void;
  onSave: () => Promise<void>;
}

/**
 * The per-provider daily ceiling the scheduler enforces. Empty means unlimited, which is
 * why the inputs are strings: a number input would turn "unset" into 0.
 */
export default function QuotaSection({ provider, saving, form, onChange, onSave }: QuotaSectionProps) {
  const remaining = provider.quotaRemaining;
  return (
    <div className="mb-4">
      <label className="label text-surface-600">每日配额（可选）</label>
      <div className="flex flex-wrap gap-2">
        <input
          type="number"
          min={0}
          value={form.requests}
          onChange={(e) => onChange('requests', e.target.value)}
          placeholder="每日请求上限"
          aria-label="每日请求上限"
          className="input-field flex-1 min-w-[9rem] font-mono text-xs"
        />
        <input
          type="number"
          min={0}
          value={form.tokens}
          onChange={(e) => onChange('tokens', e.target.value)}
          placeholder="每日 Token 上限"
          aria-label="每日 Token 上限"
          className="input-field flex-1 min-w-[9rem] font-mono text-xs"
        />
        <button onClick={onSave} disabled={saving} className="btn-secondary text-xs shrink-0">
          保存配额
        </button>
      </div>
      <p className="text-[11px] text-surface-400 mt-1">
        留空表示不限制；达到上限后调度器会跳过该供应商，改用其他可用免费模型。
      </p>
      {remaining && !remaining.unlimited && (
        <p className="text-[11px] text-surface-500 mt-1">
          今日剩余：
          {remaining.requests !== undefined ? `${remaining.requests} 次请求` : '请求次数不限'}
          {' · '}
          {remaining.tokens !== undefined
            ? `${remaining.tokens.toLocaleString()} tokens`
            : 'token 不限'}
          （重启不清零）
        </p>
      )}
    </div>
  );
}

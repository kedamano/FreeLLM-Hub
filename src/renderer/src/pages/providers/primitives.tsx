import type { ProviderModel } from './types';

export function Spinner() {
  return (
    <svg
      className="animate-spin h-3 w-3"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

/** Credential state as one dot: grey means the provider needs no key at all. */
export function StatusDot({
  status,
  hasCredential,
  authType,
}: {
  status: string;
  hasCredential: boolean;
  authType: string;
}) {
  if (authType === 'none') {
    return <span role="img" aria-label="无需凭证" title="无需凭证" className="w-2 h-2 rounded-full bg-surface-300 shrink-0" />;
  }
  if (hasCredential || status === 'configured' || status === 'valid') {
    return <span role="img" aria-label="已配置" title="已配置" className="w-2 h-2 rounded-full bg-green-400 shrink-0" />;
  }
  return <span role="img" aria-label="未配置" title="未配置" className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />;
}

export function PricingBadge({ type }: { type: string }) {
  const config: Record<string, { className: string; text: string }> = {
    free: { className: 'badge-green', text: '免费' },
    local: { className: 'badge-blue', text: '本地' },
    freemium: { className: 'badge-yellow', text: '部分免费' },
    paid: { className: 'badge-red', text: '付费' },
    unknown: { className: 'badge-gray', text: '未知' },
  };
  const c = config[type] || { className: 'badge-gray', text: type || '未知' };
  return <span className={`${c.className} text-[9px] px-1.5 py-0`}>{c.text}</span>;
}

export function ModelItem({ model }: { model: ProviderModel }) {
  const supports: string[] = [];
  if (model.capabilities?.supportsStreaming) supports.push('流式');
  if (model.capabilities?.supportsVision) supports.push('视觉');
  if (model.capabilities?.supportsFunctionCalling) supports.push('函数调用');

  const ctxWindow = model.capabilities?.contextWindow
    ? model.capabilities.contextWindow >= 1000000
      ? (model.capabilities.contextWindow / 1000000).toFixed(1) + 'M'
      : (model.capabilities.contextWindow / 1000).toFixed(0) + 'K'
    : '—';

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-surface-50 border border-surface-100">
      <div className="min-w-0">
        <div className="text-sm text-surface-800 truncate">{model.displayName}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-surface-400 font-mono truncate">{model.id}</span>
          {supports.length > 0 && (
            <span className="flex gap-1 shrink-0">
              {supports.map((s) => (
                <span key={s} className="badge-gray text-[9px] px-1.5 py-0">{s}</span>
              ))}
            </span>
          )}
        </div>
      </div>
      <div className="text-right shrink-0 ml-3">
        <div className="text-[10px] text-surface-400">{ctxWindow} tokens</div>
        {model.pricing?.type && (
          <PricingBadge type={model.pricing.type} />
        )}
      </div>
    </div>
  );
}

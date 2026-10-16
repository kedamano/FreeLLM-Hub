import { useState } from 'react';
import { useIPC, getFreellmApi } from '../hooks/useIPC';
import { useProfileChanges } from '../hooks/useProfiles';
import { unwrapIpc, unwrapIpcList } from '../lib/ipc-result';
import { LoadingState, ErrorState, EmptyState } from '../components/ErrorBoundary';
import PageHeader from '../components/PageHeader';
import {
  ProviderStackChart,
  QuotaCeilingList,
  TokenCostTrendChart,
} from '../components/charts';
import { formatNumber, formatPercent, formatTokens, formatUsd } from '../lib/format';
import type {
  CallLogEntry,
  CostSummary,
  ProviderQuotaUsage,
} from '../../../shared/types/observability.js';

interface DashboardStats {
  totalRequests: number;
  successRate: number;
  totalTokensUsed: number;
  totalCostUsd?: number;
  totalCostSaved?: number;
  availableModels?: number;
  activeProviders: number;
  providerStats: Array<{
    providerId: string;
    providerName: string;
    requestCount: number;
    successCount: number;
    errorCount: number;
    costUsd?: number;
    savedCostUsd?: number;
  }>;
}

interface ReferencePrice {
  label: string;
  currency: string;
  inputPer1M: number;
  outputPer1M: number;
}

const WINDOWS = [
  { days: 7, label: '7 天' },
  { days: 14, label: '14 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
];

export default function UsagePage() {
  const [days, setDays] = useState(30);
  const [reloadKey, setReloadKey] = useState(0);
  useProfileChanges(() => setReloadKey((value) => value + 1));

  const {
    data: stats,
    loading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useIPC<DashboardStats | null>(async () => {
    const api = getFreellmApi();
    if (!api) return import.meta.env.DEV ? getMockStats() : null;
    return unwrapIpc<DashboardStats>(await api.usage.dashboard());
  }, [reloadKey]);

  const { data: cost } = useIPC<CostSummary | null>(async () => {
    const api = getFreellmApi();
    if (!api) return null;
    return api.usage.costSummary(days);
  }, [days, reloadKey]);

  const { data: quotaRows } = useIPC<ProviderQuotaUsage[]>(async () => {
    const api = getFreellmApi();
    if (!api) return [];
    return api.usage.quotaUsage();
  }, [reloadKey]);

  const { data: providerSeries } = useIPC(async () => {
    const api = getFreellmApi();
    if (!api) return [];
    return api.usage.dailyByProvider(days);
  }, [days, reloadKey]);

  const {
    data: callsData,
    loading: callsLoading,
    error: callsError,
    refetch: refetchCalls,
  } = useIPC<CallLogEntry[]>(async () => {
    const api = getFreellmApi();
    if (!api) return import.meta.env.DEV ? [] : [];
    return unwrapIpcList<CallLogEntry>(await api.usage.recentCalls(50));
  }, [reloadKey]);

  const calls = callsData ?? [];
  const topProviders = (cost?.byProvider ?? []).slice(0, 6).map((row) => row.providerId);

  if (statsError) {
    return <ErrorState message={`统计数据加载失败：${statsError}`} onRetry={refetchStats} />;
  }

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="用量与成本"
        description="免费池的额度消耗、折算成本与调用明细（数据范围：当前配置档）"
        actions={
          <>
            {WINDOWS.map((entry) => (
              <button
                key={entry.days}
                type="button"
                onClick={() => setDays(entry.days)}
                aria-pressed={days === entry.days}
                className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                  days === entry.days
                    ? 'bg-primary-600 text-white'
                    : 'bg-white text-surface-500 border border-surface-100 hover:text-surface-700'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </>
        }
      />

      {statsLoading ? (
        <LoadingState />
      ) : (
        <>

      {stats && (
        <div className="mb-4 text-[11px] text-surface-400">
          当前配置档启用 {stats.activeProviders} 个服务商、{stats.availableModels ?? 0} 个可用模型 ·
          累计 {formatNumber(stats.totalRequests)} 次请求，成功率 {formatPercent(stats.successRate)}
        </div>
      )}

      {cost && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="请求数"
            value={formatNumber(cost.requests)}
            hint={`${formatNumber(cost.successfulRequests)} 次成功`}
          />
          <StatCard
            label="Token 用量"
            value={formatTokens(cost.tokens)}
            hint={`输入 ${formatTokens(cost.promptTokens)} · 输出 ${formatTokens(cost.completionTokens)}`}
          />
          <StatCard
            label="实际成本"
            value={formatUsd(cost.costUsd)}
            hint={cost.costUsd === 0 ? '全部由免费额度承担' : '含付费模型'}
            tone="amber"
          />
          <StatCard
            label="节省成本"
            value={formatUsd(cost.savedCostUsd)}
            hint={`对比付费基准 ${formatUsd(cost.referenceCostUsd)}（${formatPercent(cost.savedRate, 0)}）`}
            tone="teal"
          />
        </div>
      )}

      <div className="card mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-surface-800">每日用量与节省成本</h3>
          <ReferencePriceEditor />
        </div>
        <TokenCostTrendChart series={cost?.series ?? []} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-3">服务商额度消耗（按天堆叠）</h3>
          <ProviderStackChart points={providerSeries ?? []} providers={topProviders} />
        </div>
        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-1">每日额度上限用量</h3>
          <p className="text-[11px] text-surface-400 mb-3">
            上限取自当前配置档的配额设置，用量为滚动 24 小时窗口
          </p>
          <div className="max-h-72 overflow-y-auto pr-1">
            <QuotaCeilingList rows={quotaRows ?? []} />
          </div>
        </div>
      </div>

      {cost && cost.byModel.length > 0 && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold text-surface-800 mb-3">模型明细</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-surface-500 border-b border-surface-100">
                  <th className="pb-2 font-medium">服务商</th>
                  <th className="pb-2 font-medium">模型</th>
                  <th className="pb-2 font-medium">计费</th>
                  <th className="pb-2 font-medium text-right">请求</th>
                  <th className="pb-2 font-medium text-right">Tokens</th>
                  <th className="pb-2 font-medium text-right">实际</th>
                  <th className="pb-2 font-medium text-right">节省</th>
                </tr>
              </thead>
              <tbody>
                {cost.byModel.map((row) => (
                  <tr key={`${row.providerId}:${row.modelId}`} className="border-b border-surface-50">
                    <td className="py-2 text-surface-700">{row.providerId}</td>
                    <td className="py-2 font-mono text-surface-500 break-all whitespace-normal">
                      {row.modelId}
                    </td>
                    <td className="py-2">
                      <span className={row.pricingType === 'free' ? 'badge-green' : 'badge-yellow'}>
                        {pricingLabel(row.pricingType)}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums text-surface-600">
                      {formatNumber(row.requests)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-surface-600">
                      {formatTokens(row.tokens)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-surface-600">
                      {formatUsd(row.costUsd)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-teal-600">
                      {formatUsd(row.savedCostUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="text-sm font-semibold text-surface-800 mb-3">最近调用记录</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-surface-500 border-b border-surface-100">
                <th className="pb-2 font-medium">时间</th>
                <th className="pb-2 font-medium">服务商</th>
                <th className="pb-2 font-medium">模型</th>
                <th className="pb-2 font-medium">状态</th>
                <th className="pb-2 font-medium text-right">延迟</th>
                <th className="pb-2 font-medium text-right">Tokens</th>
                <th className="pb-2 font-medium text-right">节省</th>
              </tr>
            </thead>
            <tbody>
              {calls.slice(0, 20).map((call) => (
                <tr key={call.id} className="border-b border-surface-50">
                  <td className="py-2 text-surface-600 whitespace-nowrap">
                    {formatTimestampSafe(call.timestamp)}
                  </td>
                  <td className="py-2 text-surface-700">{call.providerId}</td>
                  <td className="py-2 text-surface-500 font-mono break-all whitespace-normal">
                    {call.modelId}
                  </td>
                  <td className="py-2">
                    <StatusBadge status={call.status} />
                  </td>
                  <td className="py-2 text-right text-surface-500">{call.durationMs}ms</td>
                  <td className="py-2 text-right text-surface-500">
                    {call.promptTokens + call.completionTokens}
                  </td>
                  <td className="py-2 text-right text-teal-600">
                    {formatUsd(call.savedCostUsd ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {callsLoading ? (
            <LoadingState />
          ) : callsError ? (
            <ErrorState message={`调用记录加载失败：${callsError}`} onRetry={refetchCalls} />
          ) : calls.length === 0 ? (
            <EmptyState message="暂无调用记录" />
          ) : null}
        </div>
      </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = 'primary',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'primary' | 'teal' | 'amber';
}) {
  const toneClass =
    tone === 'teal' ? 'text-teal-600' : tone === 'amber' ? 'text-amber-600' : 'text-primary-600';
  return (
    <div className="card">
      <div className="text-xs text-surface-500 mb-1 font-medium">{label}</div>
      <div className={`text-2xl font-bold ${toneClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-surface-400 mt-1">{hint}</div>}
    </div>
  );
}

/**
 * The reference price is what "saved cost" is measured against. It has to be editable,
 * because a user who would otherwise pay for a different model should see a saving that
 * matches their real alternative.
 */
function ReferencePriceEditor() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ReferencePrice | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const api = getFreellmApi();

  const { data: current, refetch } = useIPC<ReferencePrice | null>(async () => {
    if (!api) return null;
    const raw = await api.settings.get('cost_reference_price');
    if (!raw) return { label: 'GPT-4o 级付费基准', currency: 'USD', inputPer1M: 2.5, outputPer1M: 10 };
    try {
      return JSON.parse(raw) as ReferencePrice;
    } catch {
      return null;
    }
  }, []);

  const value = draft ?? current;

  const save = async () => {
    if (!api || !value) return;
    setSaving(true);
    setMessage(null);
    const result = await api.settings.set('cost_reference_price', JSON.stringify(value));
    setSaving(false);
    setDraft(null);
    setMessage(result?.success === false ? '保存失败' : null);
    void refetch();
    setOpen(false);
  };

  return (
    <div className="relative">
      <button type="button" className="btn-ghost text-[11px]" onClick={() => setOpen((v) => !v)}>
        基准价：{current ? `${formatUsd(current.inputPer1M)}/${formatUsd(current.outputPer1M)} 每 1M` : '未设置'}
      </button>
      {open && value && (
        <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-surface-100 bg-white p-3 shadow-lg">
          <div className="text-xs font-semibold text-surface-700 mb-2">成本对比基准（每 100 万 tokens）</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-surface-500">
              输入价格
              <input
                className="input-field mt-1"
                type="number"
                step="0.1"
                value={value.inputPer1M}
                onChange={(event) =>
                  setDraft({ ...value, inputPer1M: Number(event.target.value) || 0 })
                }
              />
            </label>
            <label className="text-[11px] text-surface-500">
              输出价格
              <input
                className="input-field mt-1"
                type="number"
                step="0.1"
                value={value.outputPer1M}
                onChange={(event) =>
                  setDraft({ ...value, outputPer1M: Number(event.target.value) || 0 })
                }
              />
            </label>
          </div>
          <label className="mt-2 block text-[11px] text-surface-500">
            说明
            <input
              className="input-field mt-1"
              value={value.label}
              onChange={(event) => setDraft({ ...value, label: event.target.value })}
            />
          </label>
          {message && <div className="mt-2 text-[11px] text-red-600">{message}</div>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-ghost text-[11px]" onClick={() => setOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary text-[11px]"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? '保存中' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function pricingLabel(type: string | null | undefined): string {
  switch (type) {
    case 'free':
      return '免费';
    case 'freemium':
      return '免费层';
    case 'paid':
      return '付费';
    case 'local':
      return '本地';
    default:
      return '未知';
  }
}

function formatTimestampSafe(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { className: string; text: string }> = {
    success: { className: 'badge-green', text: '成功' },
    error: { className: 'badge-red', text: '失败' },
    timeout: { className: 'badge-yellow', text: '超时' },
    rate_limited: { className: 'badge-yellow', text: '限流' },
  };
  const c = config[status] || { className: 'badge-gray', text: status };
  return <span className={c.className}>{c.text}</span>;
}

function getMockStats(): DashboardStats {
  return {
    totalRequests: 0,
    successRate: 0,
    totalTokensUsed: 0,
    activeProviders: 4,
    providerStats: [],
  };
}

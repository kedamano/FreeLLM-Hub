import { useCallback, useEffect, useMemo, useState } from 'react';
import { getFreellmApi } from '../hooks/useIPC';
import { useProfileChanges } from '../hooks/useProfiles';
import { ErrorState, LoadingState, EmptyState } from '../components/ErrorBoundary';
import PageHeader from '../components/PageHeader';
import { formatDuration, formatNumber, formatPercent, formatTimestamp, formatUsd } from '../lib/format';
import type {
  AuditDetailResult,
  AuditListResult,
  AuditStatus,
  AuditSummary,
  RequestAuditRecord,
} from '../../../shared/types/observability.js';

const PAGE_SIZE = 25;

const STATUS_LABELS: Record<AuditStatus, { text: string; className: string }> = {
  in_progress: { text: '进行中', className: 'badge-blue' },
  success: { text: '成功', className: 'badge-green' },
  error: { text: '失败', className: 'badge-red' },
  rate_limited: { text: '限流', className: 'badge-yellow' },
  quota_exceeded: { text: '超额', className: 'badge-yellow' },
  rejected: { text: '被拒', className: 'badge-red' },
  timeout: { text: '超时', className: 'badge-yellow' },
  aborted: { text: '中断', className: 'badge-gray' },
};

const EVENT_LABELS: Record<string, string> = {
  'request.received': '收到请求',
  'request.rejected': '拒绝请求',
  'dispatch.start': '开始调度',
  'candidate.skipped': '候选被跳过',
  'candidate.selected': '选中候选',
  'attempt.start': '发起尝试',
  'attempt.success': '尝试成功',
  'attempt.failed': '尝试失败',
  'response.head': '响应头已发送',
  'stream.first_token': '首字节',
  'stream.completed': '流结束',
  'stream.failed': '流失败',
  'client.disconnected': '客户端断开',
  'request.completed': '请求完成',
  'request.failed': '请求失败',
  'credential.rotated': '切换密钥',
  'credential.refreshed': '刷新令牌',
};

const SKIP_REASON_LABELS: Record<string, string> = {
  disabled: '服务商已停用',
  no_adapter: '适配器未注册',
  circuit_open: '熔断器打开',
  rate_limited: '触发限流窗口',
  rate_limit_slot_taken: '并发额度被占用',
  quota_exceeded: '当日额度已用尽',
  already_attempted: '本次请求已尝试过',
  no_candidates: '没有可用候选',
};

interface Filters {
  status: AuditStatus | '';
  providerId: string;
  search: string;
  failuresOnly: boolean;
  days: number;
}

const EMPTY_FILTERS: Filters = { status: '', providerId: '', search: '', failuresOnly: false, days: 7 };

export default function AuditPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [pendingSearch, setPendingSearch] = useState('');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<AuditListResult | null>(null);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useProfileChanges(() => setTick((value) => value + 1));

  const query = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      status: filters.status || undefined,
      providerId: filters.providerId || undefined,
      search: filters.search || undefined,
      failuresOnly: filters.failuresOnly || undefined,
      from: new Date(Date.now() - filters.days * 86400_000).toISOString(),
    }),
    [page, filters]
  );

  const load = useCallback(async () => {
    const api = getFreellmApi();
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [list, stats] = await Promise.all([
        api.usage.auditList(query),
        api.usage.auditSummary(filters.days),
      ]);
      setResult(list ?? null);
      setSummary(stats ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '审计数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [query, filters.days]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const api = getFreellmApi();
    if (!api) return;
    let cancelled = false;
    setDetailLoading(true);
    api.usage
      .auditDetail(selected)
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, tick]);

  const items = result?.items ?? [];
  const total = result?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="max-w-7xl">
      <PageHeader
        title="请求审计"
        description="网关侧每个请求的完整轨迹：为什么选了这个服务商、重试了几次、被拒的原因"
        actions={
          <button type="button" className="btn-secondary text-xs" onClick={() => void load()}>
            刷新
          </button>
        }
      />

      {loading && !result ? <LoadingState /> : (<>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-5">
          <MiniStat label="请求总数" value={formatNumber(summary.requests)} />
          <MiniStat label="成功率" value={formatPercent(summary.successRate)} />
          <MiniStat
            label="进行中"
            value={formatNumber(summary.inFlight)}
            tone={summary.inFlight > 0 ? 'amber' : 'primary'}
          />
          <MiniStat label="P95 延迟" value={formatDuration(summary.p95DurationMs)} />
          <MiniStat
            label="首字节均值"
            value={summary.avgTimeToFirstTokenMs === null ? '—' : formatDuration(summary.avgTimeToFirstTokenMs)}
          />
          <MiniStat label="节省成本" value={formatUsd(summary.savedCostUsd)} tone="teal" />
        </div>
      )}

      {error && <div className="mb-4"><ErrorState message={error} onRetry={() => void load()} /></div>}

      <div className="card mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-surface-500">
            状态
            <select
              className="input-field mt-1 min-w-28"
              value={filters.status}
              onChange={(event) => {
                setPage(0);
                setFilters((prev) => ({ ...prev, status: event.target.value as AuditStatus | '' }));
              }}
            >
              <option value="">全部</option>
              {Object.entries(STATUS_LABELS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.text}
                </option>
              ))}
            </select>
          </label>

          <label className="text-[11px] text-surface-500">
            服务商
            <input
              className="input-field mt-1 min-w-32"
              placeholder="groq"
              value={filters.providerId}
              onChange={(event) => {
                setPage(0);
                setFilters((prev) => ({ ...prev, providerId: event.target.value.trim() }));
              }}
            />
          </label>

          <label className="text-[11px] text-surface-500 flex-1 min-w-52">
            搜索（请求 ID / 模型 / 错误）
            <input
              className="input-field mt-1"
              value={pendingSearch}
              onChange={(event) => setPendingSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setPage(0);
                  setFilters((prev) => ({ ...prev, search: pendingSearch.trim() }));
                }
              }}
              placeholder="req_m1x..."
            />
          </label>

          <label className="text-[11px] text-surface-500">
            时间窗
            <select
              className="input-field mt-1 min-w-24"
              value={filters.days}
              onChange={(event) => {
                setFilters((prev) => ({ ...prev, days: Number(event.target.value) }));
                setPage(0);
              }}
            >
              <option value={1}>24 小时</option>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 pb-2 text-[11px] text-surface-600">
            <input
              type="checkbox"
              checked={filters.failuresOnly}
              onChange={(event) => {
                setPage(0);
                setFilters((prev) => ({ ...prev, failuresOnly: event.target.checked }));
              }}
            />
            只看异常
          </label>

          <button
            type="button"
            className="btn-ghost text-[11px] pb-2"
            onClick={() => {
              setPendingSearch('');
              setFilters(EMPTY_FILTERS);
              setPage(0);
            }}
          >
            重置
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-surface-800">请求列表</h3>
            <span className="text-[11px] text-surface-400">共 {formatNumber(total)} 条</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-surface-500 border-b border-surface-100">
                  <th className="pb-2 font-medium">时间</th>
                  <th className="pb-2 font-medium">路由</th>
                  <th className="pb-2 font-medium">服务商 / 模型</th>
                  <th className="pb-2 font-medium">状态</th>
                  <th className="pb-2 font-medium text-right">尝试</th>
                  <th className="pb-2 font-medium text-right">延迟</th>
                  <th className="pb-2 font-medium text-right">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <AuditRow
                    key={row.requestId}
                    row={row}
                    active={selected === row.requestId}
                    onSelect={() => setSelected(row.requestId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {items.length === 0 && !loading ? <EmptyState message="该时间窗内没有请求审计记录" /> : null}
          <div className="mt-3 flex items-center justify-between text-[11px] text-surface-400">
            <button
              type="button"
              className="btn-ghost"
              disabled={page === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              上一页
            </button>
            <span>
              第 {page + 1} / {pageCount} 页
            </span>
            <button
              type="button"
              className="btn-ghost"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </button>
          </div>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-3">请求轨迹</h3>
          {!selected && <EmptyState message="选择左侧任一请求，查看它完整的调度过程" />}
          {selected && detailLoading && <LoadingState />}
          {selected && !detailLoading && !detail && <EmptyState message="该请求没有轨迹数据" />}
          {selected && detail && <AuditDetailPanel detail={detail} />}
        </div>
      </div>
      </>)}
    </div>
  );
}

function AuditRow({
  row,
  active,
  onSelect,
}: {
  row: RequestAuditRecord;
  active: boolean;
  onSelect: () => void;
}) {
  const status = STATUS_LABELS[row.status] ?? { text: row.status, className: 'badge-gray' };
  return (
    <tr
      onClick={onSelect}
      className={`border-b border-surface-50 cursor-pointer ${active ? 'bg-primary-50' : 'hover:bg-surface-50'}`}
    >
      <td className="py-2 text-surface-600 whitespace-nowrap">{formatTimestamp(row.startedAt)}</td>
      <td className="py-2 text-surface-500">
        <span className="font-mono">{row.route}</span>
        {row.stream && <span className="ml-1 text-[10px] text-violet-500">SSE</span>}
      </td>
      <td className="py-2 text-surface-700">
        {row.providerId ?? '—'}
        <span className="text-surface-400"> / </span>
        <span className="font-mono text-surface-500">{row.modelId ?? row.requestedModel ?? '—'}</span>
      </td>
      <td className="py-2">
        <span className={status.className}>{status.text}</span>
        {row.statusCode ? (
          <span className="ml-1 text-[10px] text-surface-400">{row.statusCode}</span>
        ) : null}
      </td>
      <td className="py-2 text-right tabular-nums text-surface-500">{row.attempts || '—'}</td>
      <td className="py-2 text-right tabular-nums text-surface-500">{formatDuration(row.durationMs)}</td>
      <td className="py-2 text-right tabular-nums text-surface-500">{row.totalTokens || '—'}</td>
    </tr>
  );
}

function AuditDetailPanel({ detail }: { detail: AuditDetailResult }) {
  const { request, events } = detail;
  const status = STATUS_LABELS[request.status] ?? { text: request.status, className: 'badge-gray' };

  return (
    <div className="text-xs">
      <div className="rounded-lg bg-surface-50 p-3 mb-3">
        <div className="flex items-center justify-between">
          <span className={status.className}>{status.text}</span>
          <span className="font-mono text-[10px] text-surface-400 break-all">{request.requestId}</span>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-surface-600">
          <DetailPair label="路由" value={`${request.method} ${request.route}`} />
          <DetailPair label="配置档" value={request.profileId} />
          <DetailPair label="请求模型" value={request.requestedModel ?? '自动选择'} />
          <DetailPair label="任务类型" value={request.taskType ?? '未指定'} />
          <DetailPair label="实际服务商" value={request.providerId ?? '—'} />
          <DetailPair label="实际模型" value={request.modelId ?? '—'} />
          <DetailPair label="HTTP" value={request.statusCode ?? '—'} />
          <DetailPair label="重试次数" value={request.attempts} />
          <DetailPair label="总耗时" value={formatDuration(request.durationMs)} />
          <DetailPair label="首字节" value={formatDuration(request.timeToFirstTokenMs)} />
          <DetailPair
            label="Tokens"
            value={`${request.promptTokens} + ${request.completionTokens}`}
          />
          <DetailPair label="节省" value={formatUsd(request.savedCostUsd)} />
        </dl>
        {request.params && Object.keys(request.params).length > 0 && (
          <div className="mt-2 text-[11px] text-surface-500">
            参数：{JSON.stringify(request.params)}
          </div>
        )}
        {request.errorMessage && (
          <div className="mt-2 rounded border border-red-100 bg-red-50 px-2 py-1.5 text-red-700">
            {request.errorCode ? `[${request.errorCode}] ` : ''}
            {request.errorMessage}
          </div>
        )}
      </div>

      <ol className="relative space-y-2 border-l border-surface-100 pl-4">
        {events.map((event) => {
          const skipped = event.event === 'candidate.skipped';
          const failed = event.event.includes('failed') || event.event === 'request.rejected';
          return (
            <li key={event.seq} className="relative">
              <span
                className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${
                  failed ? 'bg-red-500' : skipped ? 'bg-amber-400' : 'bg-primary-500'
                }`}
              />
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-surface-700">
                  {EVENT_LABELS[event.event] ?? event.event}
                </span>
                <span className="text-[10px] text-surface-400">{formatTimestamp(event.at, false)}</span>
              </div>
              <div className="text-[11px] text-surface-500">
                {event.providerId && <span>{event.providerId}</span>}
                {event.modelId && <span className="font-mono"> / {event.modelId}</span>}
                {event.attempt !== null && event.attempt !== undefined && (
                  <span className="ml-1">#{event.attempt + 1}</span>
                )}
                {event.reason && (
                  <span className={`ml-1 ${skipped ? 'text-amber-600' : ''}`}>
                    {SKIP_REASON_LABELS[event.reason] ?? event.reason}
                  </span>
                )}
                {event.durationMs !== null && event.durationMs !== undefined && (
                  <span className="ml-1">· {formatDuration(event.durationMs)}</span>
                )}
              </div>
              {event.detail ? (
                <div className="mt-0.5 text-[10px] text-surface-400 break-all">
                  {formatDetail(event.detail)}
                </div>
              ) : null}
            </li>
          );
        })}
        {events.length === 0 && <EmptyState message="没有事件记录" />}
      </ol>
    </div>
  );
}

function DetailPair({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-surface-400">{label}</dt>
      <dd className="truncate font-medium text-surface-700">{value ?? '—'}</dd>
    </div>
  );
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) =>
      typeof value === 'object' ? `${key}: ${JSON.stringify(value)}` : `${key}: ${String(value)}`
    )
    .join(' · ')
    .slice(0, 260);
}

function MiniStat({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'teal' | 'amber';
}) {
  const toneClass =
    tone === 'teal' ? 'text-teal-600' : tone === 'amber' ? 'text-amber-600' : 'text-primary-600';
  return (
    <div className="card">
      <div className="text-[11px] text-surface-500 mb-0.5">{label}</div>
      <div className={`text-lg font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

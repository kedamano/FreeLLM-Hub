import { useIPC, getFreellmApi } from '../hooks/useIPC';
import { unwrapIpc, unwrapIpcList } from '../lib/ipc-result';
import { LoadingState, ErrorState, EmptyState } from '../components/ErrorBoundary';

interface CallLogEntry {
  id: string;
  timestamp: string;
  providerId: string;
  modelId: string;
  status: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
}

interface DashboardStats {
  totalRequests: number;
  successRate: number;
  totalTokensUsed: number;
  activeProviders: number;
  providerStats: Array<{
    providerId: string;
    providerName: string;
    requestCount: number;
    successCount: number;
    errorCount: number;
  }>;
}

export default function UsagePage() {
  const {
    data: stats,
    loading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useIPC<DashboardStats | null>(async () => {
    const api = getFreellmApi();
    if (!api) return import.meta.env.DEV ? getMockStats() : null;
    return unwrapIpc<DashboardStats>(await api.usage.dashboard());
  });

  const {
    data: callsData,
    loading: callsLoading,
    error: callsError,
    refetch: refetchCalls,
  } = useIPC<CallLogEntry[]>(async () => {
    const api = getFreellmApi();
    if (!api) return import.meta.env.DEV ? getMockCalls() : [];
    return unwrapIpcList<CallLogEntry>(await api.usage.recentCalls(50));
  });

  const calls = callsData ?? [];

  if (statsLoading || callsLoading) {
    return <LoadingState />;
  }

  if (statsError) {
    return <ErrorState message={`统计数据加载失败：${statsError}`} onRetry={refetchStats} />;
  }

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-surface-900 tracking-tight">用量统计</h2>
        <p className="text-sm text-surface-500 mt-1">API 调用记录和资源用量</p>
      </div>

      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="card">
            <div className="text-xs text-surface-500 mb-1 font-medium">总请求数</div>
            <div className="text-2xl font-bold text-primary-600">
              {stats.totalRequests.toLocaleString()}
            </div>
          </div>
          <div className="card">
            <div className="text-xs text-surface-500 mb-1 font-medium">成功率</div>
            <div className="text-2xl font-bold text-green-600">
              {(stats.successRate * 100).toFixed(1)}%
            </div>
          </div>
          <div className="card">
            <div className="text-xs text-surface-500 mb-1 font-medium">Token 总用量</div>
            <div className="text-2xl font-bold text-violet-600">
              {stats.totalTokensUsed.toLocaleString()}
            </div>
          </div>
        </div>
      )}

      {stats?.providerStats && stats.providerStats.length > 0 && (
        <div className="card mb-6">
          <h3 className="text-sm font-semibold text-surface-800 mb-3">服务商用量</h3>
          <div className="space-y-2">
            {stats.providerStats.map((ps) => (
              <div key={ps.providerId} className="flex items-center justify-between py-1">
                <span className="text-sm text-surface-700">{ps.providerName}</span>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-surface-500">
                    {ps.requestCount} 次请求
                  </span>
                  <span className="text-green-600">{ps.successCount} 成功</span>
                  {ps.errorCount > 0 && (
                    <span className="text-red-600">{ps.errorCount} 失败</span>
                  )}
                </div>
              </div>
            ))}
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
              </tr>
            </thead>
            <tbody>
              {calls.slice(0, 20).map((call) => (
                <tr key={call.id} className="border-b border-surface-50">
                  <td className="py-2 text-surface-600 whitespace-nowrap">
                    {formatTimestamp(call.timestamp)}
                  </td>
                  <td className="py-2 text-surface-700">{call.providerId}</td>
                  <td className="py-2 text-surface-500 font-mono break-all whitespace-normal">
                    {call.modelId}
                  </td>
                  <td className="py-2">
                    <StatusBadge status={call.status} />
                  </td>
                  <td className="py-2 text-right text-surface-500">
                    {call.durationMs}ms
                  </td>
                  <td className="py-2 text-right text-surface-500">
                    {call.promptTokens + call.completionTokens}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {callsError ? (
            <ErrorState message={`调用记录加载失败：${callsError}`} onRetry={refetchCalls} />
          ) : calls.length === 0 ? (
            <EmptyState message="暂无调用记录" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

function getMockCalls(): CallLogEntry[] {
  return [];
}

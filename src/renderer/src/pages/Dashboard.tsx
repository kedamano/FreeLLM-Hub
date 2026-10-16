import { useState, useEffect, useRef, useCallback } from 'react';
import { DashboardIcon, ProviderIcon, ModelIcon, ZapIcon, ServerIcon } from '../components/Icons';
import { useIPC, getFreellmApi } from '../hooks/useIPC';
import { unwrapIpc } from '../lib/ipc-result';
import { LoadingState, ErrorState } from '../components/ErrorBoundary';

interface DashboardData {
  totalRequests: number;
  successRate: number;
  totalTokensUsed: number;
  totalCostSaved: number;
  activeProviders: number;
  availableModels: number;
}

interface GatewayStatus {
  running: boolean;
  host: string;
  port: number;
  url: string;
  authEnabled: boolean;
  hasToken: boolean;
}

const EMPTY_STATS: DashboardData = {
  totalRequests: 0,
  successRate: 0,
  totalTokensUsed: 0,
  totalCostSaved: 0,
  activeProviders: 0,
  availableModels: 0,
};

const EMPTY_GATEWAY: GatewayStatus = {
  running: false,
  host: '127.0.0.1',
  port: 0,
  url: '',
  authEnabled: false,
  hasToken: false,
};

export default function Dashboard() {
  const {
    data: stats,
    loading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useIPC<DashboardData | null>(async () => {
    const api = getFreellmApi();
    if (!api) return null;
    return unwrapIpc<DashboardData>(await api.usage.dashboard());
  });

  const {
    data: gateway,
    loading: gatewayLoading,
    error: gatewayError,
    refetch: refetchGateway,
  } = useIPC<GatewayStatus | null>(async () => {
    const api = getFreellmApi();
    if (!api) return null;
    return unwrapIpc<GatewayStatus>(await api.gateway.status());
  });

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const data = stats ?? EMPTY_STATS;
  const gatewayData = gateway ?? EMPTY_GATEWAY;

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
  }, []);

  const statsList = [
    {
      label: '总请求数',
      value: data.totalRequests.toLocaleString(),
      icon: <DashboardIcon size={18} />,
      color: 'text-primary-600',
      bgColor: 'bg-primary-50',
    },
    {
      label: '成功率',
      value: `${(data.successRate * 100).toFixed(1)}%`,
      icon: <ZapIcon size={18} />,
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-50',
    },
    {
      label: 'Token 用量',
      value: data.totalTokensUsed > 1000
        ? `${(data.totalTokensUsed / 1000).toFixed(1)}K`
        : data.totalTokensUsed.toLocaleString(),
      icon: <ModelIcon size={18} />,
      color: 'text-violet-600',
      bgColor: 'bg-violet-50',
    },
    {
      label: '活跃服务商',
      value: data.activeProviders.toString(),
      icon: <ProviderIcon size={18} />,
      color: 'text-teal-600',
      bgColor: 'bg-teal-50',
    },
  ];

  const gatewayUrl = gatewayData.url || `http://${gatewayData.host}:${gatewayData.port || '---'}`;

  if (statsLoading || gatewayLoading) {
    return <LoadingState />;
  }

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex flex-col">
        <h2 className="block text-xl font-bold text-surface-900 tracking-tight">仪表盘</h2>
        <p className="block text-sm text-surface-500 mt-1">免费 LLM 资源一站式管理</p>
      </div>

      {statsError && (
        <div className="mb-4">
          <ErrorState message={`统计数据加载失败：${statsError}`} onRetry={refetchStats} />
        </div>
      )}
      {gatewayError && !statsError && (
        <div className="mb-4 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-700 flex items-center justify-between">
          <span>网关状态获取失败：{gatewayError}</span>
          <button onClick={refetchGateway} className="btn-ghost text-xs shrink-0">
            重试
          </button>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {statsList.map((stat) => (
          <div key={stat.label} className="card card-hover flex items-start gap-3">
            <div className={`w-9 h-9 rounded-lg ${stat.bgColor} ${stat.color} flex items-center justify-center shrink-0`}>
              {stat.icon}
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-surface-400 font-medium uppercase tracking-wide">{stat.label}</div>
              <div className={`text-xl font-bold ${stat.color} mt-0.5`}>{stat.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Gateway Quick Start */}
        <div className="card card-hover">
          <div className="flex items-center gap-2 mb-3">
            <ServerIcon size={16} className="text-primary-500" />
            <h3 className="text-sm font-semibold text-surface-800">网关接入</h3>
          </div>

          {gateway === null && !gatewayError ? (
            <div className="text-sm text-surface-500 py-4 text-center">
              未连接后端服务，无法获取网关状态
            </div>
          ) : gatewayData.running ? (
            <div className="space-y-2.5">
              {/* URL */}
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 px-3 py-2 bg-surface-50 rounded-lg font-mono text-xs text-surface-700 truncate border border-surface-100">
                  {gatewayUrl}
                </div>
                <button
                  onClick={() => copyToClipboard(gatewayUrl)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-all shrink-0 ${
                    copied
                      ? 'bg-success/10 text-success'
                      : 'bg-surface-50 text-surface-600 hover:bg-surface-100 border border-surface-200'
                  }`}
                >
                  {copied ? '已复制' : '复制'}
                </button>
              </div>

              {/* Status info */}
              <div className="flex items-center gap-4 text-[11px] text-surface-500 pt-1">
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                  运行中
                </span>
                <span>{gatewayData.authEnabled ? '已认证' : '开放'}</span>
                <span>端口 {gatewayData.port}</span>
              </div>

              {/* Quick config */}
              <div className="p-2.5 bg-primary-50/50 rounded-lg mt-2">
                <div className="text-[10px] text-primary-600 font-medium mb-1">在 other agent 中配置</div>
                <div className="font-mono text-[11px] text-primary-700 leading-relaxed break-all">
                  OPENAI_BASE_URL={gatewayUrl}/v1
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-surface-500 py-4 text-center">
              网关服务未启动
            </div>
          )}
        </div>

        {/* System Status */}
        <div className="card card-hover">
          <h3 className="text-sm font-semibold text-surface-800 mb-3">系统状态</h3>
          <div className="space-y-1">
            <StatusRow
              label="本地网关"
              status={
                gatewayError ? 'unknown' : gateway === null ? 'unknown' : gatewayData.running ? 'running' : 'stopped'
              }
            />
            <StatusRow label="Ollama" status="local" />
            <StatusRow label="数据库" status="running" />
            <StatusRow label="调度器" status="running" />
          </div>
        </div>
      </div>
    </div>
  );
}

type RowStatus = 'running' | 'stopped' | 'local' | 'unknown';

function StatusRow({ label, status }: { label: string; status: RowStatus }) {
  const configs: Record<RowStatus, { dot: string; ring: string; text: string; textClass: string }> = {
    running: { dot: 'bg-emerald-500', ring: 'ring-emerald-500/20', text: '运行中', textClass: 'text-emerald-600' },
    stopped: { dot: 'bg-red-500', ring: 'ring-red-500/20', text: '已停止', textClass: 'text-red-600' },
    local: { dot: 'bg-blue-500', ring: 'ring-blue-500/20', text: '本地模式', textClass: 'text-blue-600' },
    unknown: { dot: 'bg-surface-400', ring: 'ring-surface-400/20', text: '未知', textClass: 'text-surface-500' },
  };
  const config = configs[status];

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-surface-700">{label}</span>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-medium ${config.textClass}`}>{config.text}</span>
        <span className={`w-2 h-2 rounded-full ${config.dot} ring-2 ${config.ring}`} />
      </div>
    </div>
  );
}

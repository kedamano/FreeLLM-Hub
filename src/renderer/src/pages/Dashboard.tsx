import { useState, useEffect } from 'react';

interface DashboardData {
  totalRequests: number;
  successRate: number;
  totalTokensUsed: number;
  totalCostSaved: number;
  activeProviders: number;
  availableModels: number;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData>({
    totalRequests: 0,
    successRate: 0,
    totalTokensUsed: 0,
    totalCostSaved: 0,
    activeProviders: 4,
    availableModels: 12,
  });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const stats = await (window as unknown as { freellm: { usage: { dashboard: () => Promise<DashboardData> } } }).freellm.usage.dashboard();
      setData(stats);
    } catch {
      // Use default data when not connected to backend
    }
  }

  const stats = [
    {
      label: '总请求数',
      value: data.totalRequests.toLocaleString(),
      color: 'text-primary-600',
    },
    {
      label: '成功率',
      value: `${(data.successRate * 100).toFixed(1)}%`,
      color: 'text-green-600',
    },
    {
      label: 'Token 用量',
      value: data.totalTokensUsed > 1000
        ? `${(data.totalTokensUsed / 1000).toFixed(1)}K`
        : data.totalTokensUsed.toLocaleString(),
      color: 'text-violet-600',
    },
    {
      label: '活跃服务商',
      value: data.activeProviders.toString(),
      color: 'text-amber-600',
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-surface-900">仪表盘</h2>
        <p className="text-sm text-surface-500 mt-1">免费大模型资源总览</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {stats.map((stat) => (
          <div key={stat.label} className="card">
            <div className="text-xs text-surface-500 mb-1">{stat.label}</div>
            <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-3">快速开始</h3>
          <div className="space-y-2 text-sm text-surface-600">
            <div className="p-3 bg-surface-50 rounded-md">
              <div className="font-medium text-surface-800">连接到本地网关</div>
              <div className="text-xs text-surface-500 mt-1 font-mono">
                POST http://127.0.0.1:PORT/v1/chat/completions
              </div>
            </div>
            <div className="p-3 bg-surface-50 rounded-md">
              <div className="font-medium text-surface-800">可用的免费模型</div>
              <div className="text-xs text-surface-500 mt-1">
                Ollama (本地) - Groq - Gemini Flash - Cloudflare Workers AI
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-3">系统状态</h3>
          <div className="space-y-2">
            <StatusRow label="本地网关" status="running" />
            <StatusRow label="Ollama" status="local" />
            <StatusRow label="数据库" status="running" />
            <StatusRow label="调度器" status="running" />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusRow({ label, status }: { label: string; status: 'running' | 'stopped' | 'local' }) {
  const config = {
    running: { className: 'bg-green-500', text: '运行中' },
    stopped: { className: 'bg-red-500', text: '已停止' },
    local: { className: 'bg-blue-500', text: '本地模式' },
  }[status];

  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-surface-700">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-surface-500">{config.text}</span>
        <span className={`w-2 h-2 rounded-full ${config.className}`} />
      </div>
    </div>
  );
}

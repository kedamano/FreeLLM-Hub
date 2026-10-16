import { useState, useMemo } from 'react';
import { useIPC, getFreellmApi } from '../hooks/useIPC';
import { unwrapIpcList } from '../lib/ipc-result';
import { LoadingState, ErrorState, EmptyState } from '../components/ErrorBoundary';

interface ModelCapability {
  supported: string[];
  contextWindow: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  supportsJsonMode: boolean;
}

interface ModelPricing {
  type: string;
  currency: string;
  notes?: string;
}

interface ModelInfo {
  id: string;
  providerId: string;
  providerName?: string;
  displayName: string;
  description?: string;
  capabilities: ModelCapability;
  pricing: ModelPricing;
  status: string;
}

// ─── Mock fallback ───────────────────────────────────────────────────

function getMockModels(): ModelInfo[] {
  return [
    {
      id: 'llama-3.3-70b-versatile',
      providerId: 'groq',
      providerName: 'Groq',
      displayName: 'Llama 3.3 70B Versatile',
      description: 'Meta Llama 3.3 70B 参数，高能力推理',
      capabilities: {
        supported: ['chat', 'completion', 'streaming', 'json-mode'],
        contextWindow: 131072,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: true,
        supportsJsonMode: true,
      },
      pricing: { type: 'free', currency: 'USD', notes: 'Free tier with rate limits' },
      status: 'available',
    },
    {
      id: 'llama-3.1-8b-instant',
      providerId: 'groq',
      providerName: 'Groq',
      displayName: 'Llama 3.1 8B Instant',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 131072,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: true,
        supportsJsonMode: true,
      },
      pricing: { type: 'free', currency: 'USD', notes: 'Free tier: 30 RPM' },
      status: 'available',
    },
    {
      id: 'mixtral-8x7b-32768',
      providerId: 'groq',
      providerName: 'Groq',
      displayName: 'Mixtral 8x7B',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 32768,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'free', currency: 'USD', notes: 'Free tier with rate limits' },
      status: 'available',
    },
    {
      id: 'gemma-7b-it',
      providerId: 'groq',
      providerName: 'Groq',
      displayName: 'Gemma 7B IT',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 8192,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'free', currency: 'USD', notes: 'Free tier with rate limits' },
      status: 'available',
    },
    {
      id: 'gemini-2.0-flash',
      providerId: 'google-gemini',
      providerName: 'Google Gemini',
      displayName: 'Gemini 2.0 Flash',
      description: 'Google 轻量快速模型，支持视觉',
      capabilities: {
        supported: ['chat', 'completion', 'streaming', 'vision', 'function-calling', 'json-mode'],
        contextWindow: 1048576,
        supportsStreaming: true,
        supportsVision: true,
        supportsFunctionCalling: true,
        supportsJsonMode: true,
      },
      pricing: { type: 'free', currency: 'USD', notes: 'Free tier: 15 RPM, 1M TPM' },
      status: 'available',
    },
    {
      id: 'gemini-2.5-pro',
      providerId: 'google-gemini',
      providerName: 'Google Gemini',
      displayName: 'Gemini 2.5 Pro',
      description: 'Google 最强推理模型',
      capabilities: {
        supported: ['chat', 'completion', 'streaming', 'vision', 'function-calling', 'json-mode'],
        contextWindow: 1048576,
        supportsStreaming: true,
        supportsVision: true,
        supportsFunctionCalling: true,
        supportsJsonMode: true,
      },
      pricing: { type: 'free', currency: 'USD', notes: 'Free tier: 5 RPM' },
      status: 'available',
    },
    {
      id: 'gemini-2.0-flash-lite',
      providerId: 'google-gemini',
      providerName: 'Google Gemini',
      displayName: 'Gemini 2.0 Flash Lite',
      description: '更低延迟，成本更优',
      capabilities: {
        supported: ['chat', 'completion', 'streaming', 'function-calling'],
        contextWindow: 1048576,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: true,
        supportsJsonMode: false,
      },
      pricing: { type: 'freemium', currency: 'USD', notes: 'Free / Paid' },
      status: 'available',
    },
    {
      id: '@cf/meta/llama-3.1-8b-instruct',
      providerId: 'cloudflare',
      providerName: 'Cloudflare AI',
      displayName: 'Llama 3.1 8B Instruct',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 131072,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'free', currency: 'USD', notes: '10K neurons/day' },
      status: 'available',
    },
    {
      id: '@cf/meta/llama-3.2-3b-instruct',
      providerId: 'cloudflare',
      providerName: 'Cloudflare AI',
      displayName: 'Llama 3.2 3B Instruct',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 131072,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'free', currency: 'USD', notes: '10K neurons/day' },
      status: 'available',
    },
    {
      id: '@cf/mistral/mistral-7b-instruct',
      providerId: 'cloudflare',
      providerName: 'Cloudflare AI',
      displayName: 'Mistral 7B Instruct',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 8192,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'free', currency: 'USD', notes: '10K neurons/day' },
      status: 'available',
    },
    {
      id: '@cf/google/gemma-7b-it',
      providerId: 'cloudflare',
      providerName: 'Cloudflare AI',
      displayName: 'Gemma 7B IT (Cloudflare)',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 8192,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'free', currency: 'USD', notes: '10K neurons/day' },
      status: 'available',
    },
    {
      id: 'local-model',
      providerId: 'lmstudio',
      providerName: 'LM Studio',
      displayName: 'LM Studio 本地模型',
      description: '通过 LM Studio 在本地运行的模型',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 8192,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'local', currency: 'USD', notes: '8K 本地免费推理' },
      status: 'available',
    },
    {
      id: 'local-model',
      providerId: 'ollama',
      providerName: 'Ollama',
      displayName: 'Ollama 本地模型',
      description: '通过 Ollama 在本地运行的模型',
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 8192,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'local', currency: 'USD', notes: '本地免费推理' },
      status: 'available',
    },
  ];
}

// ─── Group models by provider ────────────────────────────────────────

function groupModels(models: ModelInfo[]): Array<{
  providerId: string;
  providerName: string;
  models: ModelInfo[];
}> {
  const map = new Map<string, { providerId: string; providerName: string; models: ModelInfo[] }>();
  for (const m of models) {
    const key = m.providerId;
    if (!map.has(key)) {
      map.set(key, { providerId: m.providerId, providerName: m.providerName || m.providerId, models: [] });
    }
    map.get(key)!.models.push(m);
  }
  return Array.from(map.values());
}

// ─── Component ───────────────────────────────────────────────────────

export default function ModelsPage() {
  const [query, setQuery] = useState('');

  const {
    data: modelsData,
    loading,
    error,
    refetch,
  } = useIPC<ModelInfo[]>(async () => {
    const api = getFreellmApi();
    if (!api) return import.meta.env.DEV ? getMockModels() : [];
    return unwrapIpcList<ModelInfo>(await api.models.list());
  });

  const models = useMemo(() => modelsData ?? [], [modelsData]);

  const grouped = useMemo(
    () =>
      groupModels(
        models.filter((m) => {
          if (!query) return true;
          const q = query.toLowerCase();
          return (
            m.displayName.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q) ||
            m.providerId.toLowerCase().includes(q)
          );
        }),
      ),
    [models, query],
  );

  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return <ErrorState message={`模型列表加载失败：${error}`} onRetry={refetch} />;
  }

  return (
    <div className="flex flex-col h-full w-full max-w-5xl min-w-0">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex flex-col min-w-0">
          <h2 className="block text-xl font-bold text-surface-900 tracking-tight">模型目录</h2>
          <p className="block text-sm text-surface-500 mt-1">已发现 {models.length} 个可用模型</p>
        </div>
        <button onClick={refetch} className="btn-secondary text-xs shrink-0">
          刷新
        </button>
      </div>

      {/* Search bar */}
      <div className="mb-4">
        <label htmlFor="model-search" className="sr-only">
          搜索模型
        </label>
        <input
          id="model-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索模型名称、ID 或供应商..."
          className="input-field"
        />
      </div>

      {/* Grouped model list */}
      <div className="flex-1 overflow-y-auto space-y-5 pr-1">
        {grouped.map((group) => (
          <div key={group.providerId}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-5 h-5 rounded bg-primary-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                {group.providerName.charAt(0).toUpperCase()}
              </div>
              <h3 className="text-sm font-bold text-surface-800">{group.providerName}</h3>
              <span className="text-[10px] text-surface-400 bg-surface-100 px-1.5 rounded-full font-medium">
                {group.models.length}
              </span>
            </div>
            <div className="space-y-2">
              {group.models.map((model) => (
                <ModelCard key={`${model.providerId}-${model.id}`} model={model} />
              ))}
            </div>
          </div>
        ))}

        {grouped.length === 0 && (
          <EmptyState message="暂无匹配的模型，请先在“服务商”页面配置凭证并获取模型列表" />
        )}
      </div>
    </div>
  );
}

// ─── Model Card ──────────────────────────────────────────────────────

function ModelCard({ model }: { model: ModelInfo }) {
  const supports: Array<{ label: string; className: string }> = [];
  if (model.capabilities?.supportsStreaming) supports.push({ label: '流式', className: 'badge-gray' });
  if (model.capabilities?.supportsVision) supports.push({ label: '视觉', className: 'badge-blue' });
  if (model.capabilities?.supportsFunctionCalling) supports.push({ label: '函数调用', className: 'badge-violet' });
  if (model.capabilities?.supportsJsonMode) supports.push({ label: 'JSON', className: 'badge-yellow' });

  const ctxWindow = model.capabilities?.contextWindow
    ? model.capabilities.contextWindow >= 1000000
      ? (model.capabilities.contextWindow / 1000000).toFixed(1) + 'M'
      : model.capabilities.contextWindow >= 1000
        ? (model.capabilities.contextWindow / 1000).toFixed(0) + 'K'
        : model.capabilities.contextWindow.toString()
    : '—';

  return (
    <div className="card card-hover py-3 px-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-surface-900 truncate">{model.displayName}</h4>
            <PricingBadge type={model.pricing?.type || 'unknown'} />
          </div>
          <div className="text-[11px] font-mono text-surface-400 mt-0.5 truncate">{model.id}</div>
          {model.description && (
            <p className="text-xs text-surface-500 mt-1 line-clamp-1">{model.description}</p>
          )}
        </div>
        <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
          <span className="block text-[11px] font-mono font-medium text-surface-600 whitespace-nowrap">{ctxWindow}</span>
          {model.pricing?.notes && (
            <div className="text-[10px] text-surface-400 max-w-[140px] leading-tight">{model.pricing.notes}</div>
          )}
        </div>
      </div>
      {supports.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2 border-t border-surface-100">
          {supports.map((s) => (
            <span key={s.label} className={`${s.className} text-[10px] font-medium`}>{s.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Pricing Badge ───────────────────────────────────────────────────

function PricingBadge({ type }: { type: string }) {
  const config: Record<string, { className: string; text: string }> = {
    free: { className: 'badge-green', text: '免费' },
    local: { className: 'badge-blue', text: '本地' },
    freemium: { className: 'badge-yellow', text: '部分免费' },
    paid: { className: 'badge-red', text: '付费' },
  };
  const c = config[type] || { className: 'badge-gray', text: type || '未知' };
  return <span className={`${c.className} text-[10px] font-medium`}>{c.text}</span>;
}

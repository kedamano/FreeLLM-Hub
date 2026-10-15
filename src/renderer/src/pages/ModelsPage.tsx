import { useState, useEffect } from 'react';

interface ModelInfo {
  id: string;
  providerId: string;
  displayName: string;
  capabilities: {
    supported: string[];
    contextWindow: number;
    supportsStreaming: boolean;
    supportsVision: boolean;
    supportsFunctionCalling: boolean;
    supportsJsonMode: boolean;
  };
  pricing: {
    type: string;
    currency: string;
    notes?: string;
  };
  status: string;
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'free' | 'local'>('all');

  useEffect(() => {
    loadModels();
  }, []);

  async function loadModels() {
    setLoading(true);
    try {
      const result = await (
        window as unknown as {
          freellm: { models: { list: () => Promise<ModelInfo[]> } };
        }
      ).freellm.models.list();
      setModels(result);
    } catch {
      setModels(getMockModels());
    }
    setLoading(false);
  }

  const filteredModels = models.filter((m) => {
    if (filter === 'free') return m.pricing.type === 'free' || m.pricing.type === 'local';
    if (filter === 'local') return m.pricing.type === 'local';
    return true;
  });

  if (loading) {
    return <div className="text-center py-8 text-surface-500">加载中...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-surface-900">模型目录</h2>
          <p className="text-sm text-surface-500 mt-1">
            已发现 {models.length} 个可用模型
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadModels} className="btn-secondary text-xs">
            刷新
          </button>
          <div className="flex border border-surface-200 rounded-md overflow-hidden">
            {(['all', 'free', 'local'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === f
                    ? 'bg-primary-600 text-white'
                    : 'bg-white text-surface-600 hover:bg-surface-50'
                }`}
              >
                {f === 'all' ? '全部' : f === 'free' ? '免费' : '本地'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {filteredModels.map((model) => (
          <div key={`${model.providerId}-${model.id}`} className="card hover:border-primary-200 transition-colors">
            <div className="flex items-start justify-between mb-2">
              <div>
                <h3 className="text-sm font-semibold text-surface-900">
                  {model.displayName}
                </h3>
                <div className="text-xs text-surface-400 mt-0.5">
                  {model.providerId}
                </div>
              </div>
              <PricingBadge type={model.pricing.type} />
            </div>

            <div className="flex flex-wrap gap-1.5 mt-2">
              {model.capabilities.supportsStreaming && (
                <span className="badge-gray">流式</span>
              )}
              {model.capabilities.supportsVision && (
                <span className="badge-blue">视觉</span>
              )}
              {model.capabilities.supportsFunctionCalling && (
                <span className="badge-gray">函数调用</span>
              )}
              {model.capabilities.supportsJsonMode && (
                <span className="badge-gray">JSON</span>
              )}
            </div>

            <div className="flex items-center justify-between mt-3 text-xs text-surface-400">
              <span>上下文: {(model.capabilities.contextWindow / 1000).toFixed(0)}K</span>
              {model.pricing.notes && (
                <span className="text-surface-500 truncate ml-2">
                  {model.pricing.notes}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {filteredModels.length === 0 && (
        <div className="text-center py-12 text-surface-400">
          暂无匹配的模型
        </div>
      )}
    </div>
  );
}

function PricingBadge({ type }: { type: string }) {
  const config = {
    free: { className: 'badge-green', text: '免费' },
    local: { className: 'badge-blue', text: '本地' },
    freemium: { className: 'badge-yellow', text: '部分免费' },
    paid: { className: 'badge-red', text: '付费' },
    unknown: { className: 'badge-gray', text: '未知' },
  }[type] || { className: 'badge-gray', text: type };

  return <span className={config.className}>{config.text}</span>;
}

function getMockModels(): ModelInfo[] {
  return [
    {
      id: 'llama-3.3-70b-versatile',
      providerId: 'groq',
      displayName: 'Llama 3.3 70B Versatile',
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
      id: 'gemini-2.0-flash',
      providerId: 'google-gemini',
      displayName: 'Gemini 2.0 Flash',
      capabilities: {
        supported: ['chat', 'completion', 'streaming', 'vision', 'function-calling', 'json-mode'],
        contextWindow: 1048576,
        supportsStreaming: true,
        supportsVision: true,
        supportsFunctionCalling: true,
        supportsJsonMode: true,
      },
      pricing: { type: 'free', currency: 'USD', notes: 'Free tier: 15 RPM' },
      status: 'available',
    },
    {
      id: '@cf/meta/llama-3.1-8b-instruct',
      providerId: 'cloudflare',
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
      id: 'local-model',
      providerId: 'ollama',
      displayName: 'Ollama 本地模型',
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

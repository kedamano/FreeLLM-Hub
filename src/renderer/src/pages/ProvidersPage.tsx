import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { getFreellmApi } from '../hooks/useIPC';
import { LoadingState } from '../components/ErrorBoundary';

// ─── Types ───────────────────────────────────────────────────────────

interface ProviderInfo {
  id: string;
  displayName: string;
  authType: 'api-key' | 'oauth' | 'none' | 'custom';
  baseUrl: string;
  isEnabled: boolean;
  isBuiltIn: boolean;
  credentialStatus: string;
  hasCredential: boolean;
  metadata?: { description?: string };
}

interface ProviderModel {
  id: string;
  displayName: string;
  description?: string;
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

type ProviderGroup = 'local' | 'cloud' | 'custom';

interface GroupDef {
  key: ProviderGroup;
  label: string;
  description: string;
}

const GROUPS: GroupDef[] = [
  { key: 'local', label: '本地服务', description: 'Ollama、LM Studio 等本地推理' },
  { key: 'cloud', label: '云端服务', description: 'Groq、Gemini 等免费云端 API' },
  { key: 'custom', label: '自定义服务', description: 'OpenAI 兼容的自定义供应商' },
];

const LOCAL_IDS = ['ollama', 'lmstudio'];

// ─── Mock fallback for development ───────────────────────────────────

function getMockProviders(): ProviderInfo[] {
  return [
    {
      id: 'ollama',
      displayName: 'Ollama (本地推理)',
      authType: 'none',
      baseUrl: 'http://localhost:11434',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'configured',
      hasCredential: false,
      metadata: { description: '通过 Ollama 在本地运行开源大模型' },
    },
    {
      id: 'lmstudio',
      displayName: 'LM Studio (本地)',
      authType: 'none',
      baseUrl: 'http://localhost:1234/v1',
      isEnabled: false,
      isBuiltIn: true,
      credentialStatus: 'configured',
      hasCredential: false,
      metadata: { description: 'LM Studio OpenAI 兼容接口' },
    },
    {
      id: 'groq',
      displayName: 'Groq',
      authType: 'api-key',
      baseUrl: 'https://api.groq.com/openai/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: '免费快速推理服务 (Llama, Mixtral)' },
    },
    {
      id: 'google-gemini',
      displayName: 'Google Gemini',
      authType: 'api-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: 'Google Gemini Flash 免费额度' },
    },
    {
      id: 'cloudflare',
      displayName: 'Cloudflare Workers AI',
      authType: 'api-key',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/placeholder/ai/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: 'Workers 免费额度: 10,000 neurons/天' },
    },
    {
      id: 'huggingface',
      displayName: 'Hugging Face Inference',
      authType: 'api-key',
      baseUrl: 'https://api-inference.huggingface.co/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: 'HF Inference API 免费访问' },
    },
    {
      id: 'cerebras',
      displayName: 'Cerebras',
      authType: 'api-key',
      baseUrl: 'https://api.cerebras.ai/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: 'Cerebras 免费推理 API' },
    },
    {
      id: 'siliconflow',
      displayName: 'SiliconFlow',
      authType: 'api-key',
      baseUrl: 'https://api.siliconflow.cn/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: '硅基流动：9B 以下小模型免费' },
    },
    {
      id: 'nvidia',
      displayName: 'NVIDIA NIM',
      authType: 'api-key',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: 'NVIDIA 免费 API（限速），100+ 模型' },
    },
    {
      id: 'openrouter',
      displayName: 'OpenRouter',
      authType: 'api-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: '聚合平台，:free 模型约 50 次/天' },
    },
    {
      id: 'modelscope',
      displayName: 'ModelScope',
      authType: 'api-key',
      baseUrl: 'https://api-inference.modelscope.cn/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: '魔搭社区：约 2000 次/天 免费' },
    },
    {
      id: 'sensenova',
      displayName: 'SenseNova',
      authType: 'api-key',
      baseUrl: 'https://token.sensenova.cn/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: '商汤日日新 Token Plan 免费公测' },
    },
  ];
}

function getGroup(p: ProviderInfo): ProviderGroup {
  if (LOCAL_IDS.includes(p.id)) return 'local';
  if (p.isBuiltIn) return 'cloud';
  return 'custom';
}

// ─── Component ───────────────────────────────────────────────────────

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeGroup, setActiveGroup] = useState<ProviderGroup>('local');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Config form state
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keyIsMasked, setKeyIsMasked] = useState(false);
  const [saving, setSaving] = useState(false);

  // Model discovery
  const [discoveredModels, setDiscoveredModels] = useState<ProviderModel[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  // Inline toast (replaces alert())
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  //── Data loading ──────────────────────────────────────────────────

  const loadProviders = useCallback(async () => {
    setLoading(true);
    const apply = (result: ProviderInfo[]) => {
      setProviders(result);
      if (result.length > 0 && !selectedIdRef.current) {
        selectedIdRef.current = result[0].id;
        setSelectedId(result[0].id);
        setBaseUrl(result[0].baseUrl);
      }
    };
    try {
      const api = getFreellmApi();
      if (!api) {
        apply(getMockProviders());
      } else {
        apply(((await api.providers.list()) || []) as ProviderInfo[]);
      }
    } catch {
      apply(getMockProviders());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // Sync form only when the selected provider id actually changes,
  // so refreshing the list never overwrites in-progress input.
  const lastSyncedId = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === lastSyncedId.current) return;
    const p = providers.find((x) => x.id === selectedId);
    if (p) {
      lastSyncedId.current = selectedId;
      setBaseUrl(p.baseUrl);
      setApiKey(p.hasCredential ? '••••••••••••' : '');
      setKeyIsMasked(p.hasCredential);
      setShowKey(false);
      setDiscoveredModels([]);
      setDiscoverError(null);
    }
  }, [selectedId, providers]);

  // Restore the last persisted discovery result so switching pages
  // (or restarting the app) no longer empties the model list.
  useEffect(() => {
    if (!selectedId) return;
    const api = getFreellmApi();
    if (!api) return;
    let cancelled = false;
    api.providers
      .getModels(selectedId)
      .then((models) => {
        if (!cancelled && Array.isArray(models) && models.length > 0) {
          setDiscoveredModels(models as ProviderModel[]);
        }
      })
      .catch(() => {
        // nothing persisted yet for this provider; keep the empty state
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  //── Derived state ─────────────────────────────────────────────────

  const groupedProviders = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        providers: providers.filter((p) => getGroup(p) === g.key),
      })).filter((g) => g.providers.length > 0 || g.key === activeGroup),
    [providers, activeGroup]
  );

  const selectedProvider = providers.find((p) => p.id === selectedId);

  //── Handlers ──────────────────────────────────────────────────────

  const requireApi = useCallback(() => {
    return getFreellmApi();
  }, []);

  const handleDiscover = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;
    setDiscovering(true);
    setDiscoverError(null);
    setDiscoveredModels([]);
    try {
      const result = await api.providers.discoverModels(selectedId);
      if (result.success && result.models) {
        setDiscoveredModels(result.models as ProviderModel[]);
      } else if (result.error) {
        if (result.error.includes('ECONNREFUSED') || result.error.includes('fetch failed')) {
          setDiscoverError('无法连接到服务地址，请检查 Base URL 是否正确，并确认服务已启动。');
        } else {
          setDiscoverError(result.error);
        }
      }
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : '模型发现失败，请检查网络连接。');
    }
    setDiscovering(false);
  }, [selectedId, requireApi]);

  const handleSaveCredential = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;
    setSaving(true);
    try {
      await api.providers.setCredential(selectedId, apiKey);
      setKeyIsMasked(false);
      await handleDiscover();
      await loadProviders();
    } catch {
      showToast('error', '保存失败');
    }
    setSaving(false);
  }, [selectedId, apiKey, handleDiscover, loadProviders, showToast, requireApi]);

  const handleApiKeyChange = useCallback((value: string) => {
    setApiKey(value);
    setKeyIsMasked(false);
  }, []);

  const handleToggleShowKey = useCallback(async () => {
    if (showKey) {
      setShowKey(false);
      return;
    }
    if (keyIsMasked && selectedId) {
      const api = getFreellmApi();
      if (api) {
        try {
          const res = await api.providers.getCredential(selectedId);
          if (res?.credential) {
            setApiKey(res.credential);
            setKeyIsMasked(false);
          }
        } catch {
          // keep the masked placeholder if reveal fails
        }
      }
    }
    setShowKey(true);
  }, [showKey, keyIsMasked, selectedId]);

  const handleRemoveCredential = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;
    try {
      await api.providers.removeCredential(selectedId);
      setApiKey('');
      setKeyIsMasked(false);
      setShowKey(false);
      setDiscoveredModels([]);
      await loadProviders();
    } catch {
      showToast('error', '清除凭证失败');
    }
  }, [selectedId, loadProviders, showToast, requireApi]);

  const handleUpdateBaseUrl = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;
    setSaving(true);
    try {
      await api.providers.updateBaseUrl(selectedId, baseUrl);
      await loadProviders();
      showToast('success', 'Base URL 已更新');
    } catch {
      showToast('error', 'Base URL 更新失败');
    }
    setSaving(false);
  }, [selectedId, baseUrl, loadProviders, showToast, requireApi]);

  const handleTest = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;
    try {
      const result = await api.providers.test(selectedId);
      if (result.success) {
        showToast('success', '连接成功');
        await handleDiscover();
      } else {
        showToast('error', '连接失败' + (result.error ? ': ' + result.error : ''));
      }
    } catch {
      showToast('error', '测试失败');
    }
  }, [selectedId, handleDiscover, showToast, requireApi]);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      if (!selectedId) return;
      const api = requireApi();
      if (!api) return;
      try {
        await api.providers.toggle(selectedId, enabled);
        await loadProviders();
      } catch {
        showToast('error', '切换启用状态失败');
      }
    },
    [selectedId, loadProviders, showToast, requireApi]
  );

  //── Render ────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingState />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="mb-4 flex flex-col">
        <h2 className="block text-xl font-bold text-surface-900">服务商管理</h2>
        <p className="block text-sm text-surface-500 mt-1">管理大模型服务商的接入凭证和状态，配置后自动获取可用模型</p>
      </div>

      {toast && (
        <div
          role="status"
          className={`mb-3 px-3 py-2.5 rounded-md text-xs border ${
            toast.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Split layout */}
      <div className="flex flex-1 min-h-0 bg-white rounded-card border border-surface-100 shadow-card overflow-hidden">
        {/* Left sidebar: groups + provider list */}
        <aside className="w-72 border-r border-surface-100 flex flex-col bg-surface-50/30">
          {groupedProviders.map((group) => (
            <div key={group.key} className="pt-3">
              <button
                onClick={() => {
                  setActiveGroup(group.key);
                  const firstInGroup = group.providers[0];
                  if (firstInGroup) setSelectedId(firstInGroup.id);
                }}
                className={`w-full text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                  activeGroup === group.key
                    ? 'text-primary-700 bg-primary-50/80'
                    : 'text-surface-400 hover:text-surface-600'
                }`}
              >
                {group.label}
                <span className="ml-2 text-[10px] font-normal text-surface-300">
                  {group.providers.length}
                </span>
              </button>
              {activeGroup === group.key && (
                <ul className="mt-1 pb-2">
                  {group.providers.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => setSelectedId(p.id)}
                        className={`w-full text-left px-4 py-2.5 text-sm transition-all border-l-[3px] ${
                          selectedId === p.id
                            ? 'bg-primary-50/30 text-surface-900 font-medium border-l-primary-500'
                            : 'text-surface-600 hover:bg-surface-50 border-l-transparent hover:border-l-surface-300'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="truncate">{p.displayName}</span>
                          <StatusDot status={p.credentialStatus} hasCredential={p.hasCredential} authType={p.authType} />
                        </div>
                      </button>
                    </li>
                  ))}
                  {group.providers.length === 0 && (
                    <li className="px-4 py-2 text-xs text-surface-400 italic">暂无服务商</li>
                  )}
                </ul>
              )}
            </div>
          ))}
        </aside>

        {/* Right panel: configuration */}
        <section className="flex-1 overflow-y-auto p-6 bg-surface-50/20">
          {selectedProvider ? (
            <ConfigPanel
              provider={selectedProvider}
              baseUrl={baseUrl}
              setBaseUrl={setBaseUrl}
              apiKey={apiKey}
              onApiKeyChange={handleApiKeyChange}
              showKey={showKey}
              onToggleShowKey={handleToggleShowKey}
              saving={saving}
              onSaveCredential={handleSaveCredential}
              onRemoveCredential={handleRemoveCredential}
              onUpdateBaseUrl={handleUpdateBaseUrl}
              onTest={handleTest}
              onToggle={handleToggle}
              discoveredModels={discoveredModels}
              setDiscoveredModels={setDiscoveredModels}
              discovering={discovering}
              discoverError={discoverError}
              onDiscover={handleDiscover}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-surface-400 text-sm">
              请选择一个服务商
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Config Panel ────────────────────────────────────────────────────

interface ConfigPanelProps {
  provider: ProviderInfo;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  showKey: boolean;
  onToggleShowKey: () => void;
  saving: boolean;
  onSaveCredential: () => Promise<void>;
  onRemoveCredential: () => Promise<void>;
  onUpdateBaseUrl: () => Promise<void>;
  onTest: () => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  discoveredModels: ProviderModel[];
  setDiscoveredModels: (m: ProviderModel[]) => void;
  discovering: boolean;
  discoverError: string | null;
  onDiscover: () => Promise<void>;
}

const ConfigPanel = memo(function ConfigPanel({
  provider,
  baseUrl,
  setBaseUrl,
  apiKey,
  onApiKeyChange,
  showKey,
  onToggleShowKey,
  saving,
  onSaveCredential,
  onRemoveCredential,
  onUpdateBaseUrl,
  onTest,
  onToggle,
  discoveredModels,
  discovering,
  discoverError,
  onDiscover,
}: ConfigPanelProps) {
  const showCredSection = provider.authType !== 'none';

  return (
    <div className="max-w-2xl">
      {/* Provider header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-surface-900 tracking-tight">{provider.displayName}</h3>
          {provider.metadata?.description && (
            <p className="text-sm text-surface-500 mt-1">{provider.metadata.description}</p>
          )}
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0 ml-4">
          <span className="text-xs text-surface-500">{provider.isEnabled ? '已启用' : '已禁用'}</span>
          <input
            type="checkbox"
            checked={provider.isEnabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="w-4 h-4 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
          />
        </label>
      </div>

      {/* Base URL */}
      <div className="mb-4">
        <label className="label text-surface-600">Base URL</label>
        <div className="flex gap-2">
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="input-field flex-1 font-mono text-xs"
          />
          <button
            onClick={onUpdateBaseUrl}
            disabled={saving}
            className="btn-secondary text-xs shrink-0"
          >
            更新
          </button>
        </div>
      </div>

      {/* API Format (visual only for now) */}
      <div className="mb-4">
        <label className="label">API 格式</label>
        <select className="input-field text-sm" defaultValue="openai">
          <option value="openai">OpenAI Chat Completions (/v1/chat/completions)</option>
          <option value="anthropic">Anthropic Messages (/v1/messages)</option>
        </select>
      </div>

      {/* Credential */}
      {showCredSection && (
        <div className="mb-5">
          <label className="label">{provider.authType === 'oauth' ? 'OAuth Token' : 'API Key'}</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                placeholder="输入 API Key 或 Token"
                className="input-field pr-10 font-mono text-xs"
              />
              <button
                type="button"
                onClick={onToggleShowKey}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 text-xs"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            <button
              onClick={onSaveCredential}
              disabled={saving || !apiKey || apiKey === '••••••••••••'}
              className="btn-primary text-xs shrink-0"
            >
              {provider.hasCredential ? '更新' : '保存'}
            </button>
            {provider.hasCredential && (
              <button onClick={onRemoveCredential} className="btn-danger text-xs shrink-0">
                清除
              </button>
            )}
          </div>
        </div>
      )}

      {/* Test connection */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onTest} className="btn-secondary text-xs">
          测试连接
        </button>
        {!showCredSection && (
          <span className="text-xs text-surface-400">本地服务无需凭证，点击测试连接验证可用性</span>
        )}
      </div>

      {/* Model discovery section */}
      <div className="border-t border-surface-100 pt-5">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-surface-800">可用模型</h4>
          <button
            onClick={onDiscover}
            disabled={discovering}
            className="btn-secondary text-xs"
          >
            {discovering ? (
              <span className="flex items-center gap-1.5">
                <Spinner /> 获取中...
              </span>
            ) : discoveredModels.length > 0 ? (
              '刷新模型列表'
            ) : (
              '获取模型列表'
            )}
          </button>
        </div>

        {discoverError && (
          <div className="mb-3 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-700">
            {discoverError}
          </div>
        )}

        {discoveredModels.length > 0 ? (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {discoveredModels.map((m) => (
              <ModelItem key={m.id} model={m} />
            ))}
          </div>
        ) : !discovering && !discoverError ? (
          <div className="text-center py-8 bg-surface-50/50 rounded-md">
            <div className="text-surface-400 text-sm mb-1">尚未获取模型列表</div>
            <p className="text-xs text-surface-300">配置 API Key 并保存后将自动获取，也可点击 "获取模型列表" 手动刷新</p>
          </div>
        ) : null}
      </div>
    </div>
  );
});

// ─── Model Item ──────────────────────────────────────────────────────

function ModelItem({ model }: { model: ProviderModel }) {
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

// ─── Status Dot ──────────────────────────────────────────────────────

function StatusDot({ status, hasCredential, authType }: { status: string; hasCredential: boolean; authType: string }) {
  if (authType === 'none') {
    return <span role="img" aria-label="无需凭证" title="无需凭证" className="w-2 h-2 rounded-full bg-surface-300 shrink-0" />;
  }
  if (hasCredential || status === 'configured' || status === 'valid') {
    return <span role="img" aria-label="已配置" title="已配置" className="w-2 h-2 rounded-full bg-green-400 shrink-0" />;
  }
  return <span role="img" aria-label="未配置" title="未配置" className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />;
}

// ─── Pricing Badge ───────────────────────────────────────────────────

function PricingBadge({ type }: { type: string }) {
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

// ─── Spinner ─────────────────────────────────────────────────────────

function Spinner() {
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

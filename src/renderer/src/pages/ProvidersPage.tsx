import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { getFreellmApi } from '../hooks/useIPC';
import { assertOk, unwrapOrThrow } from '../lib/ipc-result';
import { LoadingState, ErrorState } from '../components/ErrorBoundary';
import OAuthPanel from '../components/OAuthPanel';
import type { OAuthCredentialState } from '../../../shared/types/observability.js';

// ─── Types ───────────────────────────────────────────────────────────

interface ProviderConfigFieldInfo {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

interface ProviderInfo {
  id: string;
  displayName: string;
  authType: 'api-key' | 'oauth' | 'none' | 'custom';
  baseUrl: string;
  isEnabled: boolean;
  isBuiltIn: boolean;
  credentialStatus: string;
  hasCredential: boolean;
  configFields?: ProviderConfigFieldInfo[];
  settings?: Record<string, unknown>;
  baseUrlDerived?: boolean;
  quota?: { maxRequestsPerDay?: number; maxTokensPerDay?: number };
  quotaRemaining?: { requests?: number; tokens?: number; unlimited: boolean };
  oauth?: OAuthCredentialState | null;
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

interface CredentialSlot {
  index: number;
  keyId: string;
  masked: string;
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

function getGroup(p: ProviderInfo): ProviderGroup {  if (LOCAL_IDS.includes(p.id)) return 'local';
  if (p.isBuiltIn) return 'cloud';
  return 'custom';
}

// ─── Component ───────────────────────────────────────────────────────

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<ProviderGroup>('local');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Config form state
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keyIsMasked, setKeyIsMasked] = useState(false);
  const [saving, setSaving] = useState(false);

  // Provider-specific non-secret config fields (e.g. Cloudflare accountId)
  const [extraSettings, setExtraSettings] = useState<Record<string, string>>({});

  // Daily quota (per provider) enforced by the scheduler
  const [quotaRequests, setQuotaRequests] = useState('');
  const [quotaTokens, setQuotaTokens] = useState('');

  // Multi-key state
  const [savedKeys, setSavedKeys] = useState<CredentialSlot[]>([]);
  const [revealedKeys, setRevealedKeys] = useState<Record<number, string>>({});
  const [backupInput, setBackupInput] = useState('');
  const [addingBackup, setAddingBackup] = useState(false);

  // Model discovery
  const [discoveredModels, setDiscoveredModels] = useState<ProviderModel[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  // Custom provider creation form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [creating, setCreating] = useState(false);

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
      if (!api) throw new Error('未连接后端服务');
      apply(unwrapOrThrow<ProviderInfo[]>(await api.providers.list(), '供应商列表加载失败'));
      setLoadError(null);
    } catch (err) {
      if (import.meta.env.DEV) {
        apply(getMockProviders());
        setLoadError(null);
      } else {
        setProviders([]);
        setLoadError(err instanceof Error ? err.message : '供应商列表加载失败');
      }
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
      setRevealedKeys({});
      setBackupInput('');
      const extras: Record<string, string> = {};
      for (const field of p.configFields ?? []) {
        if (field.key === 'baseUrl') continue;
        const stored = p.settings?.[field.key];
        extras[field.key] = typeof stored === 'string' ? stored : '';
      }
      setExtraSettings(extras);
      setQuotaRequests(p.quota?.maxRequestsPerDay ? String(p.quota.maxRequestsPerDay) : '');
      setQuotaTokens(p.quota?.maxTokensPerDay ? String(p.quota.maxTokensPerDay) : '');
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

  // Keep the saved-key list in sync with the selected provider.
  useEffect(() => {
    if (!selectedId) {
      setSavedKeys([]);
      return;
    }
    const api = getFreellmApi();
    if (!api) return;
    let cancelled = false;
    api.providers
      .listCredentials(selectedId)
      .then((res) => {
        if (!cancelled) setSavedKeys(res?.credentials ?? []);
      })
      .catch(() => {
        if (!cancelled) setSavedKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, providers]);

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
      const res = await api.providers.setCredential(selectedId, apiKey);
      assertOk(res, '保存失败');
      setKeyIsMasked(false);
      await handleDiscover();
      await loadProviders();
      showToast('success', 'API Key 已保存');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '保存失败');
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
      const res = await api.providers.removeCredential(selectedId);
      assertOk(res, '清除凭证失败');
      setApiKey('');
      setKeyIsMasked(false);
      setShowKey(false);
      setDiscoveredModels([]);
      await loadProviders();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '清除凭证失败');
    }
  }, [selectedId, loadProviders, showToast, requireApi]);

  const handleAddBackupKey = useCallback(async () => {
    if (!selectedId || !backupInput.trim()) return;
    const api = requireApi();
    if (!api) return;
    setAddingBackup(true);
    try {
      const res = await api.providers.addCredential(selectedId, backupInput.trim());
      if (!res.success) {
        showToast('error', res.error || '添加失败');
      } else {
        setSavedKeys(res.credentials ?? []);
        setBackupInput('');
        showToast('success', '备用 Key 已添加，限流时将自动轮换');
        await loadProviders();
      }
    } catch {
      showToast('error', '添加失败');
    }
    setAddingBackup(false);
  }, [selectedId, backupInput, loadProviders, showToast, requireApi]);

  const handleRemoveKeySlot = useCallback(
    async (index: number) => {
      if (!selectedId) return;
      const api = requireApi();
      if (!api) return;
      if (!window.confirm(`确定删除 Key ${index + 1}？其余 Key 会自动补位。`)) return;
      try {
        const res = await api.providers.removeCredentialSlot(selectedId, index);
        if (!res.success) {
          showToast('error', res.error || '删除失败');
          return;
        }
        setSavedKeys(res.credentials ?? []);
        setRevealedKeys({});
        if (index === 0) {
          setApiKey('');
          setKeyIsMasked(false);
          setShowKey(false);
        }
        await loadProviders();
      } catch {
        showToast('error', '删除失败');
      }
    },
    [selectedId, loadProviders, showToast, requireApi]
  );

  const handleRevealKey = useCallback(
    async (index: number) => {
      if (!selectedId) return;
      if (revealedKeys[index] !== undefined) {
        const next = { ...revealedKeys };
        delete next[index];
        setRevealedKeys(next);
        return;
      }
      const api = getFreellmApi();
      if (!api) return;
      try {
        const res = await api.providers.getCredential(selectedId, index);
        setRevealedKeys((prev) => ({ ...prev, [index]: res?.credential ?? '' }));
      } catch {
        // keep masked if reveal fails
      }
    },
    [selectedId, revealedKeys]
  );

  const handleUpdateBaseUrl = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;
    setSaving(true);
    try {
      const res = await api.providers.updateBaseUrl(selectedId, baseUrl);
      assertOk(res, 'Base URL 更新失败');
      await loadProviders();
      showToast('success', 'Base URL 已更新');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Base URL 更新失败');
    }
    setSaving(false);
  }, [selectedId, baseUrl, loadProviders, showToast, requireApi]);

  const handleSaveExtraSettings = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;
    setSaving(true);
    try {
      const res = await api.providers.updateConfig(selectedId, { settings: extraSettings });
      assertOk(res, '配置保存失败');
      await loadProviders();
      showToast('success', '配置已保存');
      await handleDiscover();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '配置保存失败');
    }
    setSaving(false);
  }, [selectedId, extraSettings, loadProviders, showToast, requireApi, handleDiscover]);

  const handleExtraSettingsChange = useCallback((key: string, value: string) => {
    setExtraSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSaveQuota = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;

    const toNumber = (value: string): number | undefined => {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const n = Number(trimmed);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN;
    };
    const payload = {
      maxRequestsPerDay: toNumber(quotaRequests),
      maxTokensPerDay: toNumber(quotaTokens),
    };
    if (Number.isNaN(payload.maxRequestsPerDay) || Number.isNaN(payload.maxTokensPerDay)) {
      showToast('error', '配额需要是不小于 0 的整数（留空表示不限制）');
      return;
    }

    setSaving(true);
    try {
      const res = await api.providers.setQuota(selectedId, payload);
      assertOk(res, '配额保存失败');
      await loadProviders();
      showToast(
        'success',
        payload.maxRequestsPerDay || payload.maxTokensPerDay ? '每日配额已更新' : '已取消该供应商的配额限制'
      );
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '配额保存失败');
    }
    setSaving(false);
  }, [selectedId, quotaRequests, quotaTokens, loadProviders, showToast, requireApi]);

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
        const res = await api.providers.toggle(selectedId, enabled);
        assertOk(res, '切换启用状态失败');
        await loadProviders();
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : '切换启用状态失败');
      }
    },
    [selectedId, loadProviders, showToast, requireApi]
  );

  const handleCreateCustom = useCallback(async () => {
    const api = requireApi();
    if (!api) return;
    if (!newName.trim() || !/^https?:\/\/\S+$/i.test(newBaseUrl.trim())) {
      showToast('error', '请填写名称和以 http(s):// 开头的 Base URL');
      return;
    }
    setCreating(true);
    try {
      const res = await api.providers.createCustom({
        name: newName.trim(),
        baseUrl: newBaseUrl.trim(),
        apiKey: newApiKey.trim() || undefined,
      });
      if (!res.success || !res.providerId) {
        showToast('error', res.error || '创建失败');
        setCreating(false);
        return;
      }
      const newId = res.providerId;
      setShowAddForm(false);
      setNewName('');
      setNewBaseUrl('');
      setNewApiKey('');
      setCreating(false);
      await loadProviders();
      setActiveGroup('custom');
      setSelectedId(newId);
      setDiscoveredModels([]);
      if (newApiKey.trim()) {
        const discovered = await api.providers.discoverModels(newId);
        if (discovered.success && discovered.models) setDiscoveredModels(discovered.models as ProviderModel[]);
      }
      showToast('success', '自定义供应商已创建');
    } catch (err) {
      setCreating(false);
      showToast('error', err instanceof Error ? err.message : '创建失败');
    }
  }, [newName, newBaseUrl, newApiKey, loadProviders, showToast, requireApi]);

  const handleDeleteCustom = useCallback(async () => {
    if (!selectedId) return;
    const api = requireApi();
    if (!api) return;
    if (!window.confirm('确定删除该自定义供应商？其模型与凭证将一并移除。')) return;
    try {
      const res = await api.providers.deleteCustom(selectedId);
      if (!res.success) {
        showToast('error', res.error || '删除失败');
        return;
      }
      lastSyncedId.current = null;
      setSelectedId(null);
      setDiscoveredModels([]);
      await loadProviders();
      showToast('success', '供应商已删除');
    } catch {
      showToast('error', '删除失败');
    }
  }, [selectedId, loadProviders, showToast, requireApi]);

  const providerListRef = useRef<HTMLDivElement | null>(null);
  const scrollProviderList = useCallback((dir: 1 | -1) => {
    providerListRef.current?.scrollBy({ top: dir * 240, behavior: 'smooth' });
  }, []);

  //── Render ────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingState />;
  }

  if (loadError) {
    return <ErrorState message={loadError} onRetry={loadProviders} />;
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
      <div className="flex flex-col lg:flex-row flex-1 min-h-0 bg-white rounded-card border border-surface-100 shadow-card overflow-hidden">
        {/* Left sidebar: groups + provider list */}
        <aside className="w-full lg:w-60 xl:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-surface-100 flex flex-col min-h-0 max-h-64 lg:max-h-none bg-surface-50/30">
          <div ref={providerListRef} className="flex-1 min-h-0 overflow-y-auto">
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
          </div>
          <div className="shrink-0 flex gap-2 px-3 pt-2">
            <button
              onClick={() => scrollProviderList(-1)}
              aria-label="向上翻页"
              className="flex-1 py-1.5 rounded-md border border-surface-200 bg-white text-[11px] text-surface-500 hover:text-primary-600 hover:border-primary-300 transition-colors"
            >
              ▲ 上翻
            </button>
            <button
              onClick={() => scrollProviderList(1)}
              aria-label="向下翻页"
              className="flex-1 py-1.5 rounded-md border border-surface-200 bg-white text-[11px] text-surface-500 hover:text-primary-600 hover:border-primary-300 transition-colors"
            >
              ▼ 下翻
            </button>
          </div>
          <div className="shrink-0 p-3 border-t border-surface-100">
            <button
              onClick={() => setShowAddForm(true)}
              className="w-full px-3 py-2 rounded-lg text-xs font-medium text-primary-600 bg-primary-50/60 hover:bg-primary-50 border border-primary-100 transition-colors"
            >
              ＋ 添加自定义供应商
            </button>
            <p className="mt-1.5 text-[10px] text-surface-400 leading-relaxed">
              支持任意 OpenAI 兼容 API（含中转站）
            </p>
          </div>
        </aside>

        {/* Right panel: configuration */}
        <section className="flex-1 min-w-0 overflow-y-auto p-4 lg:p-6 bg-surface-50/20">
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
              savedKeys={savedKeys}
              revealedKeys={revealedKeys}
              backupInput={backupInput}
              onBackupInputChange={setBackupInput}
              addingBackup={addingBackup}
              onAddBackup={handleAddBackupKey}
              onRemoveKeySlot={handleRemoveKeySlot}
              onRevealKey={handleRevealKey}
              onUpdateBaseUrl={handleUpdateBaseUrl}
              extraSettings={extraSettings}
              onExtraSettingsChange={handleExtraSettingsChange}
              onSaveExtraSettings={handleSaveExtraSettings}
              quotaRequests={quotaRequests}
              quotaTokens={quotaTokens}
              onQuotaChange={(field, value) =>
                field === 'requests' ? setQuotaRequests(value) : setQuotaTokens(value)
              }
              onSaveQuota={handleSaveQuota}
              onReload={() => void loadProviders()}
              onTest={handleTest}
              onToggle={handleToggle}
              onDeleteCustom={selectedProvider && !selectedProvider.isBuiltIn ? handleDeleteCustom : undefined}
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

      {showAddForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setShowAddForm(false)}
        >
          <div
            className="w-[26rem] bg-white rounded-card shadow-xl p-5"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="添加自定义供应商"
          >
            <h3 className="text-sm font-semibold text-surface-800 mb-1">添加自定义供应商</h3>
            <p className="text-xs text-surface-500 mb-4">
              支持任意 OpenAI 兼容 API（含中转站），Base URL 通常以 /v1 结尾
            </p>
            <label className="label">名称</label>
            <input
              className="input-field mb-3"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="如：我的中转站"
            />
            <label className="label">Base URL</label>
            <input
              className="input-field mb-3 font-mono text-xs"
              value={newBaseUrl}
              onChange={(e) => setNewBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
            <label className="label">API Key（可选，可稍后配置）</label>
            <input
              type="password"
              className="input-field mb-4 font-mono text-xs"
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              placeholder="sk-..."
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAddForm(false)} className="btn-secondary text-xs">
                取消
              </button>
              <button
                onClick={handleCreateCustom}
                disabled={creating}
                className="btn-primary text-xs"
              >
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
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
  savedKeys: CredentialSlot[];
  revealedKeys: Record<number, string>;
  backupInput: string;
  onBackupInputChange: (value: string) => void;
  addingBackup: boolean;
  onAddBackup: () => void;
  onRemoveKeySlot: (index: number) => void;
  onRevealKey: (index: number) => void;
  onUpdateBaseUrl: () => Promise<void>;
  extraSettings: Record<string, string>;
  onExtraSettingsChange: (key: string, value: string) => void;
  onSaveExtraSettings: () => Promise<void>;
  quotaRequests: string;
  quotaTokens: string;
  onQuotaChange: (field: 'requests' | 'tokens', value: string) => void;
  onSaveQuota: () => Promise<void>;
  /** Re-read providers from the main process, e.g. after an OAuth round-trip. */
  onReload: () => void;
  onTest: () => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onDeleteCustom?: () => Promise<void>;
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
  savedKeys,
  revealedKeys,
  backupInput,
  onBackupInputChange,
  addingBackup,
  onAddBackup,
  onRemoveKeySlot,
  onRevealKey,
  onUpdateBaseUrl,
  extraSettings,
  onExtraSettingsChange,
  onSaveExtraSettings,
  quotaRequests,
  quotaTokens,
  onQuotaChange,
  onSaveQuota,
  onReload,
  onTest,
  onToggle,
  onDeleteCustom,
  discoveredModels,
  discovering,
  discoverError,
  onDiscover,
}: ConfigPanelProps) {
  const showCredSection = provider.authType !== 'none';
  const extraFields = (provider.configFields ?? []).filter((f) => f.key !== 'baseUrl');

  return (
    <div className="w-full max-w-3xl">
      {/* Provider header */}
      <div className="flex flex-wrap items-start justify-between gap-y-2 mb-6">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-surface-900 tracking-tight">{provider.displayName}</h3>
          {provider.metadata?.description && (
            <p className="text-sm text-surface-500 mt-1">{provider.metadata.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-4">
          <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
            <span className="text-xs text-surface-500">{provider.isEnabled ? '已启用' : '已禁用'}</span>
            <input
              type="checkbox"
              checked={provider.isEnabled}
              onChange={(e) => onToggle(e.target.checked)}
              className="w-4 h-4 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
            />
          </label>
          {onDeleteCustom && (
            <button onClick={onDeleteCustom} className="btn-danger text-xs">
              删除供应商
            </button>
          )}
        </div>
      </div>

      {/* Base URL */}
      <div className="mb-4">
        <label className="label text-surface-600">Base URL</label>
        {provider.baseUrlDerived ? (
          <div className="input-field text-sm bg-surface-50 text-surface-600 flex items-center justify-between">
            <span className="font-mono text-xs truncate">{baseUrl}</span>
            <span className="text-[10px] text-surface-400 shrink-0 ml-2">由服务参数自动生成</span>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="input-field flex-1 min-w-0 font-mono text-xs"
            />
            <button
              onClick={onUpdateBaseUrl}
              disabled={saving}
              className="btn-secondary text-xs shrink-0"
            >
              更新
            </button>
          </div>
        )}
      </div>

      {/* Provider-specific config fields (e.g. Cloudflare accountId) */}
      {extraFields.length > 0 && (
        <div className="mb-4">
          <label className="label text-surface-600">服务参数</label>
          <div className="space-y-3">
            {extraFields.map((field) => (
              <div key={field.key}>
                <div className="flex gap-2">
                  <input
                    type={field.type === 'url' ? 'url' : 'text'}
                    value={extraSettings[field.key] ?? ''}
                    onChange={(e) => onExtraSettingsChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="input-field flex-1 min-w-0 font-mono text-xs"
                    aria-label={field.label}
                  />
                  <button
                    onClick={onSaveExtraSettings}
                    disabled={saving}
                    className="btn-secondary text-xs shrink-0"
                  >
                    保存参数
                  </button>
                </div>
                <p className="text-[11px] text-surface-400 mt-1">
                  {field.label}
                  {field.required ? '（必填）' : ''}
                  {field.help ? ` · ${field.help}` : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily quota enforced by the scheduler */}
      <div className="mb-4">
        <label className="label text-surface-600">每日配额（可选）</label>
        <div className="flex flex-wrap gap-2">
          <input
            type="number"
            min={0}
            value={quotaRequests}
            onChange={(e) => onQuotaChange('requests', e.target.value)}
            placeholder="每日请求上限"
            aria-label="每日请求上限"
            className="input-field flex-1 min-w-[9rem] font-mono text-xs"
          />
          <input
            type="number"
            min={0}
            value={quotaTokens}
            onChange={(e) => onQuotaChange('tokens', e.target.value)}
            placeholder="每日 Token 上限"
            aria-label="每日 Token 上限"
            className="input-field flex-1 min-w-[9rem] font-mono text-xs"
          />
          <button onClick={onSaveQuota} disabled={saving} className="btn-secondary text-xs shrink-0">
            保存配额
          </button>
        </div>
        <p className="text-[11px] text-surface-400 mt-1">
          留空表示不限制；达到上限后调度器会跳过该供应商，改用其他可用免费模型。
        </p>
        {provider.quotaRemaining && !provider.quotaRemaining.unlimited && (
          <p className="text-[11px] text-surface-500 mt-1">
            今日剩余：
            {provider.quotaRemaining.requests !== undefined
              ? `${provider.quotaRemaining.requests} 次请求`
              : '请求次数不限'}
            {' · '}
            {provider.quotaRemaining.tokens !== undefined
              ? `${provider.quotaRemaining.tokens.toLocaleString()} tokens`
              : 'token 不限'}
            （重启不清零）
          </p>
        )}
      </div>

      {/* OAuth: short-lived tokens that the app refreshes automatically */}
      <OAuthPanel
        providerId={provider.id}
        displayName={provider.displayName}
        settings={provider.settings ?? {}}
        credential={provider.oauth}
        onChanged={onReload}
      />

      {/* API Format: fixed per provider, shown read-only */}
      <div className="mb-4">
        <label className="label">API 格式</label>
        <div className="input-field text-sm bg-surface-50 text-surface-600 flex items-center justify-between">
          <span>OpenAI Chat Completions (/v1/chat/completions)</span>
          <span className="text-[10px] text-surface-400 shrink-0 ml-2">由服务商决定</span>
        </div>
      </div>

      {/* Credential */}
      {showCredSection && (
        <div className="mb-5">
          <label className="label">{provider.authType === 'oauth' ? 'OAuth Token' : 'API Key'}</label>
          <div className="flex gap-2">
            <div className="relative flex-1 min-w-0">
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

          {savedKeys.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="text-[11px] text-surface-400">已保存的 Key（限流 / 失效时自动轮换）</div>
              {savedKeys.map((k) => (
                <div
                  key={k.keyId}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-surface-50 border border-surface-100"
                >
                  <span className="text-[10px] font-semibold text-surface-500 shrink-0">
                    Key {k.index + 1}
                    {k.index === 0 ? '（主）' : ''}
                  </span>
                  <span className="flex-1 text-xs font-mono text-surface-600 truncate">
                    {revealedKeys[k.index] ?? k.masked}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRevealKey(k.index)}
                    className="text-[11px] text-surface-400 hover:text-surface-600 shrink-0"
                  >
                    {revealedKeys[k.index] !== undefined ? '隐藏' : '显示'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveKeySlot(k.index)}
                    className="text-[11px] text-red-400 hover:text-red-600 shrink-0"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <input
              type="password"
              value={backupInput}
              onChange={(e) => onBackupInputChange(e.target.value)}
              placeholder="添加备用 Key（可选）"
              className="input-field flex-1 min-w-0 font-mono text-xs"
            />
            <button
              onClick={onAddBackup}
              disabled={addingBackup || !backupInput.trim()}
              className="btn-secondary text-xs shrink-0"
            >
              {addingBackup ? '添加中…' : '＋ 添加备用'}
            </button>
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

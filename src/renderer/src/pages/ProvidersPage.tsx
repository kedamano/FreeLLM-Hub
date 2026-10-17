import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getFreellmApi } from '../hooks/useIPC';
import { useQueryParams } from '../hooks/useQueryParam';
import { assertOk, unwrapOrThrow } from '../lib/ipc-result';
import { LoadingState, ErrorState } from '../components/ErrorBoundary';
import { getMockProviders } from './providers/mock-providers';
import ProviderListPanel from './providers/ProviderListPanel';
import AddCustomProviderDialog, {
  validateNewProviderDraft,
  type NewProviderDraft,
} from './providers/AddCustomProviderDialog';
import ConfigPanel, {
  type DiscoveryState,
  type EndpointActions,
  type EndpointForm,
} from './providers/ConfigPanel';
import { MASKED_KEY, type CredentialActions, type CredentialForm } from './providers/CredentialSection';
import type { QuotaForm } from './providers/QuotaSection';
import {
  getProviderGroup,
  PROVIDER_GROUPS,
  type CredentialSlot,
  type ProviderGroup,
  type ProviderInfo,
  type ProviderModel,
} from './providers/types';

// ─── Component ───────────────────────────────────────────────────────

const PROVIDER_PARAMS = ['provider', 'group'] as const;

const GROUP_KEYS = PROVIDER_GROUPS.map((group) => group.key);

function groupFromParam(value: string | undefined): ProviderGroup | null {
  return value && GROUP_KEYS.includes(value as ProviderGroup)
    ? (value as ProviderGroup)
    : null;
}

/**
 * Provider management: a grouped list on the left, one provider's config on the right.
 *
 * The page owns every request and all form state; the panels under `./providers` only render
 * and report. Which provider is open lives in the URL so a config problem can be linked.
 */
export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [params, setParams] = useQueryParams(PROVIDER_PARAMS);
  const selectedId = params.provider ?? null;
  const setSelectedId = useCallback(
    (id: string | null) => setParams({ provider: id }),
    [setParams]
  );

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

  const [showAddForm, setShowAddForm] = useState(false);
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
  }, [setSelectedId]);

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
      setApiKey(p.hasCredential ? MASKED_KEY : '');
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

  const selectedProvider = providers.find((p) => p.id === selectedId);

  // An explicit group in the link wins; otherwise the open provider decides which list is
  // showing, so `?provider=groq` cannot land on a list that hides the thing it selected.
  const requestedGroup = groupFromParam(params.group);
  const activeGroup: ProviderGroup =
    requestedGroup ?? (selectedProvider ? getProviderGroup(selectedProvider) : 'local');

  const groupedProviders = useMemo(
    () =>
      PROVIDER_GROUPS.map((g) => ({
        ...g,
        providers: providers.filter((p) => getProviderGroup(p) === g.key),
      })).filter((g) => g.providers.length > 0 || g.key === activeGroup),
    [providers, activeGroup]
  );

  //── Handlers ──────────────────────────────────────────────────────

  const requireApi = useCallback(() => {
    return getFreellmApi();
  }, []);

  const handleSelectGroup = useCallback(
    (group: ProviderGroup, firstProviderId?: string) =>
      setParams(firstProviderId ? { group, provider: firstProviderId } : { group }),
    [setParams]
  );

  const handleSelectProvider = useCallback(
    (id: string) => setParams({ provider: id, group: null }),
    [setParams]
  );

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
          const res = await api.providers.revealCredential(selectedId);
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
        const res = await api.providers.revealCredential(selectedId, index);
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

  const handleQuotaChange = useCallback(
    (field: 'requests' | 'tokens', value: string) => {
      if (field === 'requests') setQuotaRequests(value);
      else setQuotaTokens(value);
    },
    []
  );

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

  const handleCreateCustom = useCallback(
    async (draft: NewProviderDraft) => {
      const invalid = validateNewProviderDraft(draft);
      if (invalid) {
        showToast('error', invalid);
        return;
      }
      const api = requireApi();
      if (!api) return;
      setCreating(true);
      try {
        const res = await api.providers.createCustom({
          name: draft.name,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey || undefined,
        });
        if (!res.success || !res.providerId) {
          showToast('error', res.error || '创建失败');
          setCreating(false);
          return;
        }
        const newId = res.providerId;
        setShowAddForm(false);
        setCreating(false);
        await loadProviders();
        setParams({ group: 'custom', provider: newId });
        setDiscoveredModels([]);
        if (draft.apiKey) {
          const discovered = await api.providers.discoverModels(newId);
          if (discovered.success && discovered.models)
            setDiscoveredModels(discovered.models as ProviderModel[]);
        }
        showToast('success', '自定义供应商已创建');
      } catch (err) {
        setCreating(false);
        showToast('error', err instanceof Error ? err.message : '创建失败');
      }
    },
    [loadProviders, showToast, requireApi, setParams]
  );

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
      selectedIdRef.current = null;
      setParams({ provider: null, group: null });
      setDiscoveredModels([]);
      await loadProviders();
      showToast('success', '供应商已删除');
    } catch {
      showToast('error', '删除失败');
    }
  }, [selectedId, loadProviders, showToast, requireApi, setParams]);

  //── Render ────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingState />;
  }

  if (loadError) {
    return <ErrorState message={loadError} onRetry={loadProviders} />;
  }

  const endpointForm: EndpointForm = { baseUrl, extraSettings };
  const endpointActions: EndpointActions = {
    onBaseUrlChange: setBaseUrl,
    onSaveBaseUrl: handleUpdateBaseUrl,
    onExtraSettingChange: handleExtraSettingsChange,
    onSaveExtraSettings: handleSaveExtraSettings,
  };
  const credentialForm: CredentialForm = {
    apiKey,
    showKey,
    savedKeys,
    revealedKeys,
    backupInput,
    addingBackup,
  };
  const credentialActions: CredentialActions = {
    onChange: handleApiKeyChange,
    onChangeBackup: setBackupInput,
    onToggleReveal: handleToggleShowKey,
    onSave: handleSaveCredential,
    onRemove: handleRemoveCredential,
    onAddBackup: handleAddBackupKey,
    onRemoveSlot: handleRemoveKeySlot,
    onRevealSlot: handleRevealKey,
  };
  const quotaForm: QuotaForm = { requests: quotaRequests, tokens: quotaTokens };
  const discovery: DiscoveryState = {
    models: discoveredModels,
    discovering,
    error: discoverError,
    onDiscover: handleDiscover,
  };

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
        <ProviderListPanel
          groups={groupedProviders}
          activeGroup={activeGroup}
          selectedId={selectedId}
          onSelectGroup={handleSelectGroup}
          onSelectProvider={handleSelectProvider}
          onShowAddForm={() => setShowAddForm(true)}
        />

        <section className="flex-1 min-w-0 overflow-y-auto p-4 lg:p-6 bg-surface-50/20">
          {selectedProvider ? (
            <ConfigPanel
              provider={selectedProvider}
              saving={saving}
              endpoints={{ form: endpointForm, actions: endpointActions }}
              credentials={{ form: credentialForm, actions: credentialActions }}
              quota={{ form: quotaForm, onChange: handleQuotaChange, onSave: handleSaveQuota }}
              discovery={discovery}
              onReload={() => void loadProviders()}
              onTest={handleTest}
              onToggle={handleToggle}
              onDeleteCustom={selectedProvider.isBuiltIn ? undefined : handleDeleteCustom}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-surface-400 text-sm">
              请选择一个服务商
            </div>
          )}
        </section>
      </div>

      {showAddForm && (
        <AddCustomProviderDialog
          creating={creating}
          onClose={() => setShowAddForm(false)}
          onSubmit={handleCreateCustom}
        />
      )}
    </div>
  );
}

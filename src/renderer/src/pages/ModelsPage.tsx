import { useMemo, useState } from 'react';
import { useIPC, getFreellmApi } from '../hooks/useIPC';
import { useQueryParam } from '../hooks/useQueryParam';
import { unwrapIpcList } from '../lib/ipc-result';
import { LoadingState, ErrorState, EmptyState } from '../components/ErrorBoundary';
import PaginationBar from '../components/PaginationBar';
import type { ModelCapabilities } from '../../../shared/types/index.js';

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
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  status: string;
}

const PAGE_SIZE_OPTIONS = [24, 48, 96];
const DEFAULT_PAGE_SIZE = 48;

const CAPABILITY_FILTERS: Array<{ key: keyof ModelCapabilities; label: string }> = [
  { key: 'supportsStreaming', label: '流式' },
  { key: 'supportsVision', label: '视觉' },
  { key: 'supportsFunctionCalling', label: '函数调用' },
  { key: 'supportsJsonMode', label: 'JSON' },
];

// ─── Component ───────────────────────────────────────────────────────

export default function ModelsPage() {
  const [rawQuery, setQuery] = useQueryParam('q');
  const query = rawQuery ?? '';

  const [providerId, setProviderId] = useState('');
  const [capability, setCapability] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const {
    data: modelsData,
    loading,
    error,
    refetch,
  } = useIPC<ModelInfo[]>(async () => {
    const api = getFreellmApi();
    if (!api) return [];
    return unwrapIpcList<ModelInfo>(await api.models.list());
  });

  const models = useMemo(() => modelsData ?? [], [modelsData]);

  // Provider options, sorted by display name, derived once from the catalog.
  const providers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of models) {
      if (!seen.has(m.providerId)) seen.set(m.providerId, m.providerName || m.providerId);
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [models]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models
      .filter((m) => {
        if (providerId && m.providerId !== providerId) return false;
        if (capability && !m.capabilities?.[capability as keyof ModelCapabilities]) return false;
        if (!q) return true;
        return (
          m.displayName.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.providerName || m.providerId).toLowerCase().includes(q)
        );
      })
      // Cluster by provider, then by name, so the grid reads in logical blocks.
      .sort((a, b) => {
        const pa = a.providerName || a.providerId;
        const pb = b.providerName || b.providerId;
        return pa === pb ? a.displayName.localeCompare(b.displayName) : pa.localeCompare(pb);
      });
  }, [models, query, providerId, capability]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const paged = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const clearFilters = () => {
    setQuery(undefined);
    setProviderId('');
    setCapability('');
    setPage(0);
  };

  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return <ErrorState message={`模型列表加载失败：${error}`} onRetry={refetch} />;
  }

  const hasFilters = Boolean(query || providerId || capability);

  return (
    <div className="mx-auto flex h-full w-full min-w-0 max-w-7xl flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="block text-xl font-bold tracking-tight text-surface-900">模型目录</h2>
          <p className="block mt-1 text-sm text-surface-500">
            {hasFilters
              ? `已发现 ${models.length} 个模型 · 匹配 ${filtered.length} 个`
              : `已发现 ${models.length} 个可用模型`}
          </p>
        </div>
        <button onClick={refetch} className="btn-secondary shrink-0 text-xs">
          刷新
        </button>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="model-search" className="sr-only">
          搜索模型
        </label>
        <div className="relative min-w-52 flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400">
            <SearchIcon size={14} />
          </span>
          <input
            id="model-search"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="搜索模型名称、ID 或供应商..."
            className="input-field pl-8"
          />
        </div>

        <select
          aria-label="按服务商筛选"
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setPage(0);
          }}
          className="input-field w-auto min-w-32"
        >
          <option value="">全部服务商</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-surface-400">能力</span>
          <button
            type="button"
            onClick={() => {
              setCapability('');
              setPage(0);
            }}
            aria-pressed={capability === ''}
            className={`chip ${capability === '' ? 'chip-active' : ''}`}
          >
            全部
          </button>
          {CAPABILITY_FILTERS.map((cap) => (
            <button
              key={cap.key}
              type="button"
              onClick={() => {
                setCapability((prev) => (prev === cap.key ? '' : cap.key));
                setPage(0);
              }}
              aria-pressed={capability === cap.key}
              className={`chip ${capability === cap.key ? 'chip-active' : ''}`}
            >
              {cap.label}
            </button>
          ))}
        </div>

        {hasFilters && (
          <button type="button" className="btn-ghost text-[11px]" onClick={clearFilters}>
            重置
          </button>
        )}
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {paged.length === 0 ? (
          <EmptyState
            message="没有匹配的模型"
            hint="试试清除筛选条件，或先在“服务商”页面配置凭证并获取模型列表"
            icon="🔍"
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {paged.map((model) => (
              <ModelCard
                key={`${model.providerId}-${model.id}`}
                model={model}
                providerLabel={model.providerName || model.providerId}
              />
            ))}
          </div>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="border-t border-surface-100 pt-1">
          <PaginationBar
            page={safePage}
            pageCount={pageCount}
            total={filtered.length}
            unitLabel="个模型"
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(0);
            }}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}

// ─── Model Card ──────────────────────────────────────────────────────

function ModelCard({ model, providerLabel }: { model: ModelInfo; providerLabel?: string }) {
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
    <div className="card card-hover flex h-full flex-col py-3 px-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-surface-900 truncate">{model.displayName}</h4>
            <PricingBadge type={model.pricing?.type || 'unknown'} />
          </div>
          {providerLabel && (
            <div className="mt-0.5 truncate text-[11px] font-medium text-primary-600">
              {providerLabel}
            </div>
          )}
        </div>
        <span className="shrink-0 whitespace-nowrap text-[11px] font-mono font-medium text-surface-500">
          {ctxWindow}
        </span>
      </div>
      <div className="mt-1 truncate text-[11px] font-mono text-surface-400">{model.id}</div>
      {model.description && (
        <p className="mt-1 line-clamp-2 text-xs text-surface-500">{model.description}</p>
      )}
      {supports.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1.5 pt-2.5">
          {supports.map((s) => (
            <span key={s.label} className={`${s.className} text-[10px] font-medium`}>
              {s.label}
            </span>
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

function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

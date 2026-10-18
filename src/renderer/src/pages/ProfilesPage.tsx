import { useState } from 'react';
import { useProfiles } from '../hooks/useProfiles';
import { useIPC, getFreellmApi } from '../hooks/useIPC';
import { ErrorState, LoadingState, EmptyState } from '../components/ErrorBoundary';
import PageHeader from '../components/PageHeader';
import { formatNumber, formatTokens, formatUsd } from '../lib/format';
import type { ProfileView } from '../../../shared/types/observability.js';

/**
 * Configuration profile management.
 *
 * A profile is a per-project free pool: enabled providers, their base URL / account
 * settings and their daily quotas. Credentials and the model catalogue stay global, and
 * any setting a profile does not override is inherited from 默认配置档.
 */
export default function ProfilesPage() {
  const { profiles, active, loading, error, refresh, switchTo, create, rename, remove, resetPool } =
    useProfiles();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const { data: providerCount } = useIPC<number>(async () => {
    const api = getFreellmApi();
    if (!api) return 0;
    const list = await api.providers.list();
    return Array.isArray(list) ? list.length : 0;
  }, []);

  const bodyLoading = loading && profiles.length === 0;

  const submitCreate = async () => {
    if (!name.trim()) {
      setMessage({ text: '请输入配置档名称', tone: 'err' });
      return;
    }
    setBusy(true);
    const result = await create({
      name: name.trim(),
      description: description.trim() || undefined,
      copyFrom: copyFrom || undefined,
    });
    setBusy(false);
    if (result.ok) {
      setName('');
      setDescription('');
      setCopyFrom('');
      setMessage({ text: '配置档已创建', tone: 'ok' });
    } else {
      setMessage({ text: result.error ?? '创建失败', tone: 'err' });
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="配置档"
        description={
          active
            ? `当前使用「${active.name}」。每个项目一份免费池：启用哪些服务商、各自的 Base URL/参数与每日额度；密钥与模型目录全局共享。`
            : '为不同项目准备不同的免费池：启用哪些服务商、各自的 Base URL/参数与每日额度。密钥与模型目录全局共享，未覆盖的设置继承「默认配置档」。'
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={() => void refresh()} />
      ) : bodyLoading ? (
        <LoadingState />
      ) : (<>

      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-surface-800 mb-3">新建配置档</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            className="input-field"
            placeholder="名称，例如「工作项目」"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
          />
          <input
            className="input-field md:col-span-2"
            placeholder="说明（可选）"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={120}
          />
          <select
            className="input-field"
            value={copyFrom}
            onChange={(event) => setCopyFrom(event.target.value)}
          >
            <option value="">从空白开始</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                复制自：{profile.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => void submitCreate()}>
            {busy ? '创建中…' : '创建'}
          </button>
          {message && (
            <span className={`text-xs ${message.tone === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
              {message.text}
            </span>
          )}
        </div>
        <p className="mt-2 text-[11px] text-surface-400">
          全局共 {formatNumber(providerCount ?? 0)} 个可用服务商；新配置档默认继承默认配置档的启用状态与额度。
        </p>
      </div>

      <div className="space-y-3">
        {profiles.map((profile) => (
          <ProfileCard
            key={profile.id}
            profile={profile}
            isActive={profile.isActive}
            editing={editing === profile.id}
            onEdit={() => setEditing(profile.id)}
            onDoneEditing={() => setEditing(null)}
            onSaveEdit={async (patch) => {
              const result = await rename(profile.id, patch);
              setMessage(
                result.ok
                  ? { text: '已保存', tone: 'ok' }
                  : { text: result.error ?? '保存失败', tone: 'err' }
              );
              if (result.ok) setEditing(null);
            }}
            onActivate={async () => {
              const result = await switchTo(profile.id);
              setMessage(
                result.ok
                  ? { text: `已切换到「${profile.name}」`, tone: 'ok' }
                  : { text: result.error ?? '切换失败', tone: 'err' }
              );
            }}
            onResetPool={async () => {
              await resetPool(profile.id);
              setMessage({ text: '已重置该配置档的服务商池', tone: 'ok' });
            }}
            onDelete={async () => {
              const result = await remove(profile.id);
              setMessage(
                result.ok
                  ? { text: '配置档已删除', tone: 'ok' }
                  : { text: result.error ?? '删除失败', tone: 'err' }
              );
            }}
          />
        ))}
        {profiles.length === 0 && <EmptyState message="还没有配置档" />}
      </div>

      <div className="card mt-6 text-[11px] text-surface-500 leading-relaxed">
        <div className="text-sm font-semibold text-surface-800 mb-2">切换配置档时会发生什么</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>立即生效：服务商启用状态、Base URL/参数覆盖、每日额度上限，以及该配置档自己的当日用量计数。</li>
          <li>不受影响：API 密钥（服务商级共享）、模型目录、网关地址与令牌、界面偏好。</li>
          <li>用量与审计面板会自动切到新配置档的数据范围；历史调用记录按配置档标记，不会互相污染。</li>
        </ul>
      </div>
      </>)}
    </div>
  );
}

function ProfileCard({
  profile,
  isActive,
  editing,
  onEdit,
  onDoneEditing,
  onSaveEdit,
  onActivate,
  onResetPool,
  onDelete,
}: {
  profile: ProfileView;
  isActive: boolean;
  editing: boolean;
  onEdit: () => void;
  onDoneEditing: () => void;
  onSaveEdit: (patch: { name?: string; description?: string }) => Promise<void>;
  onActivate: () => Promise<void>;
  onResetPool: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <div className={`card ${isActive ? 'ring-1 ring-primary-200' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input className="input-field" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} />
              <input
                className="input-field"
                value={description}
                placeholder="说明"
                onChange={(event) => setDescription(event.target.value)}
                maxLength={120}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary text-xs"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await onSaveEdit({ name: name.trim(), description: description.trim() });
                    setBusy(false);
                  }}
                >
                  保存
                </button>
                <button type="button" className="btn-ghost text-xs" onClick={onDoneEditing}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-surface-800">{profile.name}</h3>
                {isActive && <span className="badge-blue">使用中</span>}
                {profile.isDefault && <span className="badge-gray">默认</span>}
              </div>
              <p className="text-xs text-surface-500 mt-1">{profile.description || '无说明'}</p>
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!isActive && !editing && (
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onActivate();
                setBusy(false);
              }}
            >
              切换到此档
            </button>
          )}
          {!editing && (
            <button type="button" className="btn-secondary text-xs" onClick={onEdit}>
              重命名
            </button>
          )}
          {!profile.isDefault && !editing && (
            <>
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={async () => {
                  setBusy(true);
                  await onResetPool();
                  setBusy(false);
                }}
              >
                重置服务商池
              </button>
              <button
                type="button"
                className="btn-danger text-xs"
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm(`确定删除配置档「${profile.name}」？其配额与启用设置会一并删除。`)) return;
                  setBusy(true);
                  await onDelete();
                  setBusy(false);
                }}
              >
                删除
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-surface-500">
        <span>启用服务商：{profile.stats.enabledProviders}</span>
        <span>已配额度：{profile.stats.quotaConfigured}</span>
        <span>累计请求：{formatNumber(profile.stats.requests)}</span>
        <span>Tokens：{formatTokens(profile.stats.tokens)}</span>
        <span>实际成本：{formatUsd(profile.stats.costUsd)}</span>
        <span className="text-teal-600">节省：{formatUsd(profile.stats.savedCostUsd)}</span>
      </div>
    </div>
  );
}

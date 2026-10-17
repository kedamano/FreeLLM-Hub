import OAuthPanel from '../../components/OAuthPanel';
import { ModelItem, Spinner } from './primitives';
import CredentialSection, { type CredentialActions, type CredentialForm } from './CredentialSection';
import QuotaSection, { type QuotaForm } from './QuotaSection';
import type { ProviderConfigFieldInfo, ProviderInfo, ProviderModel } from './types';

export interface EndpointForm {
  baseUrl: string;
  extraSettings: Record<string, string>;
}

export interface EndpointActions {
  onBaseUrlChange: (value: string) => void;
  onSaveBaseUrl: () => Promise<void>;
  onExtraSettingChange: (key: string, value: string) => void;
  onSaveExtraSettings: () => Promise<void>;
}

export interface DiscoveryState {
  models: ProviderModel[];
  discovering: boolean;
  error: string | null;
  onDiscover: () => Promise<void>;
}

interface ConfigPanelProps {
  provider: ProviderInfo;
  saving: boolean;
  endpoints: { form: EndpointForm; actions: EndpointActions };
  credentials: { form: CredentialForm; actions: CredentialActions };
  quota: { form: QuotaForm; onChange: (field: 'requests' | 'tokens', value: string) => void; onSave: () => Promise<void> };
  discovery: DiscoveryState;
  /** Re-read providers from the main process, e.g. after an OAuth round-trip. */
  onReload: () => void;
  onTest: () => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onDeleteCustom?: () => Promise<void>;
}

/** Everything the right-hand panel shows for one provider: endpoints, keys, quota, models. */
export default function ConfigPanel({
  provider,
  saving,
  endpoints,
  credentials,
  quota,
  discovery,
  onReload,
  onTest,
  onToggle,
  onDeleteCustom,
}: ConfigPanelProps) {
  const showCredSection = provider.authType !== 'none';
  const extraFields: ProviderConfigFieldInfo[] = (provider.configFields ?? []).filter(
    (f) => f.key !== 'baseUrl'
  );

  return (
    <div className="w-full max-w-3xl">
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

      <div className="mb-4">
        <label className="label text-surface-600">Base URL</label>
        {provider.baseUrlDerived ? (
          <div className="input-field text-sm bg-surface-50 text-surface-600 flex items-center justify-between">
            <span className="font-mono text-xs truncate">{endpoints.form.baseUrl}</span>
            <span className="text-[10px] text-surface-400 shrink-0 ml-2">由服务参数自动生成</span>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="url"
              value={endpoints.form.baseUrl}
              onChange={(e) => endpoints.actions.onBaseUrlChange(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="input-field flex-1 min-w-0 font-mono text-xs"
            />
            <button
              onClick={endpoints.actions.onSaveBaseUrl}
              disabled={saving}
              className="btn-secondary text-xs shrink-0"
            >
              更新
            </button>
          </div>
        )}
      </div>

      {extraFields.length > 0 && (
        <div className="mb-4">
          <label className="label text-surface-600">服务参数</label>
          <div className="space-y-3">
            {extraFields.map((field) => (
              <div key={field.key}>
                <div className="flex gap-2">
                  <input
                    type={field.type === 'url' ? 'url' : 'text'}
                    value={endpoints.form.extraSettings[field.key] ?? ''}
                    onChange={(e) => endpoints.actions.onExtraSettingChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="input-field flex-1 min-w-0 font-mono text-xs"
                    aria-label={field.label}
                  />
                  <button
                    onClick={endpoints.actions.onSaveExtraSettings}
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

      <QuotaSection
        provider={provider}
        saving={saving}
        form={quota.form}
        onChange={quota.onChange}
        onSave={quota.onSave}
      />

      <OAuthPanel
        providerId={provider.id}
        displayName={provider.displayName}
        settings={provider.settings ?? {}}
        credential={provider.oauth}
        onChanged={onReload}
      />

      <div className="mb-4">
        <label className="label">API 格式</label>
        <div className="input-field text-sm bg-surface-50 text-surface-600 flex items-center justify-between">
          <span>OpenAI Chat Completions (/v1/chat/completions)</span>
          <span className="text-[10px] text-surface-400 shrink-0 ml-2">由服务商决定</span>
        </div>
      </div>

      {showCredSection && (
        <CredentialSection provider={provider} saving={saving} form={credentials.form} actions={credentials.actions} />
      )}

      <div className="flex items-center gap-3 mb-6">
        <button onClick={onTest} className="btn-secondary text-xs">
          测试连接
        </button>
        {!showCredSection && (
          <span className="text-xs text-surface-400">本地服务无需凭证，点击测试连接验证可用性</span>
        )}
      </div>

      <div className="border-t border-surface-100 pt-5">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-surface-800">可用模型</h4>
          <button onClick={discovery.onDiscover} disabled={discovery.discovering} className="btn-secondary text-xs">
            {discovery.discovering ? (
              <span className="flex items-center gap-1.5">
                <Spinner /> 获取中...
              </span>
            ) : discovery.models.length > 0 ? (
              '刷新模型列表'
            ) : (
              '获取模型列表'
            )}
          </button>
        </div>

        {discovery.error && (
          <div className="mb-3 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-700">
            {discovery.error}
          </div>
        )}

        {discovery.models.length > 0 ? (
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {discovery.models.map((m) => (
              <ModelItem key={m.id} model={m} />
            ))}
          </div>
        ) : !discovery.discovering && !discovery.error ? (
          <div className="text-center py-8 bg-surface-50/50 rounded-md">
            <div className="text-surface-400 text-sm mb-1">尚未获取模型列表</div>
            <p className="text-xs text-surface-300">
              配置 API Key 并保存后将自动获取，也可点击 "获取模型列表" 手动刷新
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

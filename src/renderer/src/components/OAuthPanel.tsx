import { useEffect, useState } from 'react';
import { getFreellmApi } from '../hooks/useIPC';
import { formatUntil } from '../lib/format';
import type { OAuthCredentialState, OAuthFlowState } from '../../../shared/types/observability.js';

interface OAuthProviderSettings {
  oauth?: boolean;
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scopes?: string;
  usePkce?: boolean;
}

interface OAuthPanelProps {
  providerId: string;
  displayName: string;
  /** The provider's plain settings row; carries the OAuth endpoints when configured. */
  settings: OAuthProviderSettings | Record<string, unknown>;
  /** Snapshot from the main process; null when the provider is not OAuth-capable. */
  credential?: OAuthCredentialState | null;
  onChanged?: () => void;
}

const STATUS_TEXT: Record<string, string> = {
  active: '已授权',
  refreshing: '即将到期',
  expired: '令牌已过期',
  revoked: '刷新令牌已失效',
  error: '刷新失败',
  unconfigured: '尚未授权',
};

/**
 * OAuth control block for a provider card.
 *
 * Rendering the authorization link matters: inside Electron the browser opens
 * automatically, but in the standalone web build (and whenever the OS refuses) the user
 * has to click it themselves, and a flow with no visible link looks like a hang.
 */
export default function OAuthPanel({
  providerId,
  displayName,
  settings,
  credential,
  onChanged,
}: OAuthPanelProps) {
  const api = getFreellmApi();
  const [draft, setDraft] = useState({
    authorizationUrl: '',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    scopes: '',
  });
  const [flow, setFlow] = useState<OAuthFlowState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [state, setState] = useState<OAuthCredentialState | null>(credential ?? null);

  useEffect(() => {
    setState(credential ?? null);
  }, [credential]);

  const spec = settings as OAuthProviderSettings;
  const configured = spec.oauth === true && Boolean(spec.authorizationUrl && spec.tokenUrl && spec.clientId);

  useEffect(() => {
    if (!configured || !api) return;
    if (!flow || flow.status !== 'pending') return;
    // Poll the loopback callback result so the card updates without a manual refresh.
    const timer = setInterval(async () => {
      const status = await api.oauth.status(flow.state);
      if (!status.flow) return;
      setFlow(status.flow);
      setState(status.credential);
      if (status.flow.status !== 'pending') {
        clearInterval(timer);
        onChanged?.();
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [flow, configured, api, onChanged]);

  if (!configured) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-surface-200 p-3">
        <div className="text-xs font-semibold text-surface-700 mb-2">
          将此服务商改为 OAuth 授权（授权码 + PKCE）
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input
            className="input-field"
            placeholder="授权端点 https://.../authorize"
            value={draft.authorizationUrl}
            onChange={(event) => setDraft({ ...draft, authorizationUrl: event.target.value })}
          />
          <input
            className="input-field"
            placeholder="令牌端点 https://.../token"
            value={draft.tokenUrl}
            onChange={(event) => setDraft({ ...draft, tokenUrl: event.target.value })}
          />
          <input
            className="input-field"
            placeholder="Client ID"
            value={draft.clientId}
            onChange={(event) => setDraft({ ...draft, clientId: event.target.value })}
          />
          <input
            className="input-field"
            type="password"
            placeholder="Client Secret（公开客户端可留空）"
            value={draft.clientSecret}
            onChange={(event) => setDraft({ ...draft, clientSecret: event.target.value })}
          />
          <input
            className="input-field md:col-span-2"
            placeholder="Scopes，空格分隔"
            value={draft.scopes}
            onChange={(event) => setDraft({ ...draft, scopes: event.target.value })}
          />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={busy}
            onClick={async () => {
              if (!api) return;
              setBusy(true);
              setMessage(null);
              const result = await api.providers.configureOAuth(providerId, {
                authorizationUrl: draft.authorizationUrl.trim(),
                tokenUrl: draft.tokenUrl.trim(),
                clientId: draft.clientId.trim(),
                clientSecret: draft.clientSecret.trim() || undefined,
                scopes: draft.scopes.trim(),
                usePkce: true,
              });
              setBusy(false);
              if (!result.success) setMessage(result.error ?? '保存失败');
              else onChanged?.();
            }}
          >
            {busy ? '保存中…' : '保存 OAuth 配置'}
          </button>
          {message && <span className="text-[11px] text-red-600">{message}</span>}
        </div>
        <p className="mt-2 text-[11px] text-surface-400 leading-relaxed">
          适用于只发放短期访问令牌的免费层。保存后仍需点击「前往授权」完成一次浏览器登录，之后由程序自动刷新令牌。
        </p>
      </div>
    );
  }

  const status = state?.status ?? 'unconfigured';
  const badge =
    status === 'active'
      ? 'badge-green'
      : status === 'unconfigured' || status === 'expired' || status === 'revoked'
        ? 'badge-red'
        : 'badge-yellow';

  return (
    <div className="mt-3 rounded-lg border border-surface-100 bg-surface-50/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-surface-700">OAuth</span>
        <span className={badge}>{STATUS_TEXT[status] ?? status}</span>
        {state?.expiresAt && (
          <span className="text-[11px] text-surface-500">
            令牌 {formatUntil(state.expiresAt)}
            {state.refreshable ? ' · 可自动刷新' : ' · 无刷新令牌'}
          </span>
        )}
        {state?.scope && <span className="text-[11px] text-surface-400">范围 {state.scope}</span>}
      </div>

      {flow?.authorizationUrl && flow.status === 'pending' && (
        <div className="mt-2 rounded border border-primary-100 bg-white p-2 text-[11px]">
          <div className="text-surface-600 mb-1">请在浏览器中完成授权（10 分钟内有效）：</div>
          <a
            className="text-primary-600 underline break-all"
            href={flow.authorizationUrl}
            target="_blank"
            rel="noreferrer"
          >
            {flow.authorizationUrl}
          </a>
        </div>
      )}

      {message && <div className="mt-2 text-[11px] text-red-600">{message}</div>}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary text-xs"
          disabled={busy}
          onClick={async () => {
            if (!api) return;
            setBusy(true);
            setMessage(null);
            const result = await api.oauth.start(providerId);
            setBusy(false);
            if (!result.ok) {
              setMessage(result.error ?? '发起授权失败');
              return;
            }
            setFlow(result.flow ?? null);
          }}
        >
          {status === 'unconfigured' ? '前往授权' : '重新授权'}
        </button>
        {state?.configured && (
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={busy || !state.refreshable}
            onClick={async () => {
              if (!api) return;
              setBusy(true);
              const result = await api.oauth.refresh(providerId);
              setBusy(false);
              setState(result.credential ?? state);
              if (!result.ok) setMessage(result.error ?? '刷新失败');
              else onChanged?.();
            }}
          >
            立即刷新令牌
          </button>
        )}
        {flow?.status === 'pending' && (
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={async () => {
              if (!api) return;
              await api.oauth.cancel(flow.state);
              setFlow(null);
            }}
          >
            取消授权
          </button>
        )}
        {state?.configured && (
          <button
            type="button"
            className="btn-danger text-xs"
            onClick={async () => {
              if (!api) return;
              await api.oauth.unlink(providerId);
              setState(null);
              onChanged?.();
            }}
          >
            解绑
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-surface-400">
        访问令牌与刷新令牌以加密形式存储在本机，回调仅监听 127.0.0.1 的一次性端口。{displayName} 的请求将在令牌
        到期前 2 分钟自动续期。
      </p>
    </div>
  );
}

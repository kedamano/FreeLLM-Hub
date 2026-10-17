import { useState, useEffect, useRef, useCallback } from 'react';
import { ServerIcon, CheckIcon } from '../components/Icons';
import { useIPC, getFreellmApi, getAdminToken, setAdminToken } from '../hooks/useIPC';
import { LoadingState } from '../components/ErrorBoundary';
import UpdateCard from '../components/UpdateCard';

interface GatewaySettings {
  host: string;
  port: number;
  authEnabled: boolean;
}

interface GatewaySnapshot {
  host: string;
  port: number;
  authEnabled: boolean;
  token: string;
}

export default function SettingsPage() {
  const [gateway, setGateway] = useState<GatewaySettings>({
    host: '127.0.0.1',
    port: 3000,
    authEnabled: false,
  });

  const [gatewayToken, setGatewayToken] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showAgentHelp, setShowAgentHelp] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const savedTimer = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);

  const { data: snapshot, refetch } = useIPC<GatewaySnapshot | null>(async () => {
    const api = getFreellmApi();
    if (!api) return null;
    const status = (await api.gateway.status()) as (GatewaySnapshot | null) & {
      success?: boolean;
      error?: string;
    };
    if (!status || status.success === false) return null;
    const rawToken = await api.gateway.getToken().catch(() => '');
    const token = typeof rawToken === 'string' ? rawToken : '';
    if (!status) return null;
    return {
      host: status.host,
      port: status.port,
      authEnabled: status.authEnabled,
      token: token || '',
    };
  });

  useEffect(() => {
    if (snapshot) {
      setGateway({
        host: snapshot.host,
        port: snapshot.port,
        authEnabled: snapshot.authEnabled,
      });
      setGatewayToken(snapshot.token);
      setDirty(false);
      setLoadError(null);
    }
  }, [snapshot]);

  useEffect(() => {
    setLoading(false);
    return () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
  }, []);

  async function handleSaveGateway() {
    const api = getFreellmApi();
    if (!api) {
      setLoadError('未连接后端服务，无法保存配置');
      return;
    }
    try {
      const result = (await api.gateway.updateConfig(gateway)) as
        | { success?: boolean; error?: string }
        | null;
      if (result && result.success === false) {
        setLoadError(result.error || '网关配置保存失败');
        return;
      }
      setLoadError(null);
      setDirty(false);
      setSaved(true);
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '保存失败');
    }
  }

  const handleGenerateToken = useCallback(async () => {
    const api = getFreellmApi();
    if (!api) return;
    try {
      const token = await api.gateway.generateToken();
      if (typeof token === 'string' && token) setGatewayToken(token);
    } catch {
      // keep existing token
    }
  }, []);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
  }, []);

  const gatewayUrl = `http://${gateway.host}:${gateway.port}`;
  const agentBaseUrl = `${gatewayUrl}/v1`;

  // The desktop build talks to the main process over IPC, where there is no HTTP token to store.
  const isWebMode = typeof window !== 'undefined' && !(window as { freellm?: unknown }).freellm;
  const [adminToken, setAdminTokenState] = useState(() => getAdminToken());
  const [adminTokenSaved, setAdminTokenSaved] = useState(false);

  function handleSaveAdminToken() {
    setAdminToken(adminToken.trim());
    setAdminTokenSaved(true);
    window.setTimeout(() => setAdminTokenSaved(false), 2000);
  }

  if (loading) {
    return <LoadingState />;
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex flex-col">
        <h2 className="block text-xl font-bold text-surface-900 tracking-tight">设置</h2>
        <p className="block text-sm text-surface-500 mt-1">网关服务与认证配置</p>
      </div>

      {loadError && (
        <div className="mb-4 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-700 flex items-center justify-between">
          <span>{loadError}</span>
          <button onClick={refetch} className="btn-ghost text-xs shrink-0">
            重试
          </button>
        </div>
      )}

      <UpdateCard />

      {/* Gateway Configuration */}
      <div className="card card-hover mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ServerIcon size={16} className="text-primary-500" />
            <h3 className="text-sm font-semibold text-surface-800">网关服务</h3>
          </div>
          {dirty && !saved && (
            <span className="text-xs text-amber-600 font-medium">有未保存的修改</span>
          )}
          {saved && (
            <span className="text-xs text-success font-medium flex items-center gap-1">
              <CheckIcon size={12} /> 已保存
            </span>
          )}
        </div>

        <div className="space-y-4">
          {/* URL Display */}
          <div>
            <label className="label">网关地址</label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 px-3 py-2 bg-surface-50 rounded-lg font-mono text-sm text-surface-700 border border-surface-100 select-all truncate">
                {gatewayUrl}
              </div>
              <button
                onClick={() => copyToClipboard(agentBaseUrl)}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-all shrink-0 ${
                  copied
                    ? 'bg-success/10 text-success'
                    : 'bg-surface-50 text-surface-600 hover:bg-surface-100 border border-surface-200'
                }`}
              >
                {copied ? '已复制' : '复制 Base URL'}
              </button>
            </div>
            <p className="text-[11px] text-surface-400 mt-1">在其他 Agent 中设置 OPENAI_BASE_URL 为此值 + /v1</p>
          </div>

          {/* Auth Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <span className="block text-sm font-medium text-surface-700">启用认证</span>
              <p className="text-[11px] text-surface-400 mt-0.5">开启后需要 Token 才能调用网关</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={gateway.authEnabled}
              aria-label="启用认证"
              onClick={() => {
                setGateway({ ...gateway, authEnabled: !gateway.authEnabled });
                setDirty(true);
              }}
              className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                gateway.authEnabled ? 'bg-primary-500' : 'bg-surface-300'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  gateway.authEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Token Management */}
          {gateway.authEnabled && (
            <div>
              <label className="label">访问 Token</label>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 px-3 py-2 bg-surface-50 rounded-lg font-mono text-sm text-surface-700 border border-surface-100 overflow-hidden truncate">
                  {tokenVisible ? gatewayToken || '尚未生成' : '••••••••••••••••••••••••••••••••••'}
                </div>
                <button
                  onClick={() => setTokenVisible(!tokenVisible)}
                  className="btn-secondary text-xs"
                >
                  {tokenVisible ? '隐藏' : '显示'}
                </button>
              </div>
              <button onClick={handleGenerateToken} className="btn-secondary text-xs mt-2">
                重新生成 Token
              </button>
            </div>
          )}
        </div>
      </div>

      {isWebMode && (
        <div className="card card-hover mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-surface-800">管理端令牌</h3>
            {adminTokenSaved && (
              <span className="text-xs text-success font-medium flex items-center gap-1">
                <CheckIcon size={12} /> 已保存
              </span>
            )}
          </div>
          <label className="label">ADMIN_TOKEN</label>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={adminToken}
              onChange={(e) => setAdminTokenState(e.target.value)}
              placeholder="服务端设置了 ADMIN_TOKEN 时在此填入"
              className="input flex-1 min-w-0 font-mono text-sm"
            />
            <button onClick={handleSaveAdminToken} className="btn-secondary text-xs shrink-0">
              保存
            </button>
          </div>
          <p className="text-[11px] text-surface-400 mt-1">
            令牌只保存在本机浏览器里；留空表示服务端未启用鉴权。设置 ADMIN_TOKEN 后所有管理接口都需要它。
          </p>
        </div>
      )}

      {/* Agent Configuration Help */}
      <div className="card card-hover mb-4">
        {showAgentHelp ? (
          <>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-surface-800">Agent 配置参考</h3>
              <button onClick={() => setShowAgentHelp(false)} className="btn-ghost text-xs">
                收起
              </button>
            </div>
            <div className="space-y-3">
              <AgentConfigBlock
                name="环境变量（通用）"
                code={`OPENAI_BASE_URL=${agentBaseUrl}\n${gateway.authEnabled ? `OPENAI_API_KEY=${gatewayToken}` : '# 无需 API key'}`}
              />
              <AgentConfigBlock
                name="Claude Code (.claude/settings.json)"
                code={JSON.stringify({
                  env: {
                    OPENAI_BASE_URL: agentBaseUrl,
                    ...(gateway.authEnabled ? { OPENAI_API_KEY: gatewayToken } : {}),
                  },
                }, null, 2)}
              />
              <AgentConfigBlock
                name="OpenAI Codex CLI"
                code={`OPENAI_BASE_URL=${agentBaseUrl}\n${gateway.authEnabled ? `OPENAI_API_KEY=${gatewayToken}` : ''}`}
              />
              <AgentConfigBlock
                name="Cursor"
                code={`OPENAI_BASE_URL=${agentBaseUrl}\n${gateway.authEnabled ? `OPENAI_API_KEY=${gatewayToken}` : ''}`}
              />
              <AgentConfigBlock
                name="Continue.dev (config.json)"
                code={JSON.stringify({
                  models: [{
                    title: 'FreeLLM Hub',
                    provider: 'openai',
                    model: 'auto',
                    apiBase: agentBaseUrl,
                    ...(gateway.authEnabled ? { apiKey: gatewayToken } : {}),
                  }],
                }, null, 2)}
              />
            </div>
          </>
        ) : (
          <button
            onClick={() => setShowAgentHelp(true)}
            className="w-full text-left flex items-center justify-between py-1"
          >
            <h3 className="text-sm font-semibold text-surface-800">Agent 配置参考</h3>
            <span className="text-xs text-primary-600 font-medium">展开查看</span>
          </button>
        )}
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button onClick={handleSaveGateway} className="btn-primary">
          保存配置
        </button>
      </div>
    </div>
  );
}

function AgentConfigBlock({ name, code }: { name: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  function copy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-surface-600">{name}</span>
        <button onClick={copy} className="text-[11px] text-primary-600 font-medium hover:text-primary-700">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="bg-surface-900 text-surface-200 rounded-lg p-3 text-[11px] font-mono overflow-x-auto leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

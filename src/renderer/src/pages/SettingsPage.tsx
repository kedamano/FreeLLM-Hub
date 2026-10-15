import { useState, useEffect } from 'react';

export default function SettingsPage() {
  const [gatewayHost, setGatewayHost] = useState('127.0.0.1');
  const [gatewayPort, setGatewayPort] = useState('0');
  const [logLevel, setLogLevel] = useState('info');
  const [autoFallback, setAutoFallback] = useState(true);
  const [theme, setTheme] = useState('system');
  const [dataPath, setDataPath] = useState('');
  const [version, setVersion] = useState('0.1.0');

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const v = await (
        window as unknown as { freellm: { app: { version: () => Promise<string> } } }
      ).freellm.app.version();
      setVersion(v);
    } catch {
      // Use default
    }

    try {
      const dp = await (
        window as unknown as { freellm: { app: { dataPath: () => Promise<string> } } }
      ).freellm.app.dataPath();
      setDataPath(dp);
    } catch {
      // Use default
    }
  }

  async function handleSave() {
    try {
      const freellm = (window as unknown as {
        freellm: {
          settings: { set: (key: string, value: string) => Promise<{ success: boolean }> };
        };
      }).freellm;
      await freellm.settings.set('logLevel', logLevel);
      await freellm.settings.set('theme', theme);
      await freellm.settings.set('autoFallback', String(autoFallback));
      alert('设置已保存');
    } catch {
      alert('无法连接到后端，设置未保存');
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-surface-900">设置</h2>
        <p className="text-sm text-surface-500 mt-1">应用配置和偏好</p>
      </div>

      <div className="max-w-2xl space-y-6">
        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-4">网关设置</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">监听地址</label>
              <input
                type="text"
                value={gatewayHost}
                onChange={(e) => setGatewayHost(e.target.value)}
                className="input-field"
                placeholder="127.0.0.1"
              />
            </div>
            <div>
              <label className="label">端口</label>
              <input
                type="number"
                value={gatewayPort}
                onChange={(e) => setGatewayPort(e.target.value)}
                className="input-field"
                placeholder="0 = 自动分配"
              />
            </div>
          </div>
          <p className="text-xs text-surface-400 mt-2">
            网关为外部应用提供 OpenAI 兼容的 API 接口。端口设为 0 可自动分配空闲端口。
          </p>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-4">调度器</h3>
          <div className="space-y-3">
            <label className="flex items-center justify-between">
              <div>
                <span className="text-sm text-surface-700">自动故障切换</span>
                <p className="text-xs text-surface-400">当当前模型不可用时自动切换</p>
              </div>
              <input
                type="checkbox"
                checked={autoFallback}
                onChange={(e) => setAutoFallback(e.target.checked)}
                className="w-4 h-4 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
              />
            </label>
          </div>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-4">通用</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">日志级别</label>
              <select
                value={logLevel}
                onChange={(e) => setLogLevel(e.target.value)}
                className="input-field"
              >
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div>
              <label className="label">主题</label>
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                className="input-field"
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-surface-800 mb-4">关于</h3>
          <div className="space-y-2 text-sm text-surface-600">
            <div className="flex justify-between">
              <span>版本</span>
              <span className="font-mono text-surface-800">{version}</span>
            </div>
            <div className="flex justify-between">
              <span>数据目录</span>
              <span className="font-mono text-xs text-surface-400 truncate max-w-xs">
                {dataPath || '默认路径'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button onClick={handleSave} className="btn-primary">
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}

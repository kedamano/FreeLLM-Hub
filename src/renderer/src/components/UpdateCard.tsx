import { useCallback, useEffect, useState } from 'react';
import { getFreellmApi } from '../hooks/useIPC';
import type { UpdateStateView } from '../../../shared/types/observability.js';
import { useProfileChanges } from '../hooks/useProfiles';

/**
 * 应用更新与数据管理。
 *
 * 更新: electron-updater 在打包环境才可用, unpackaged 运行时返回 'unsupported' —— 这里
 * 必须照实显示而不是装作检查过。数据管理: 调用账本 CSV/JSONL 导出、按配置档清空。
 */
export default function UpdateCard() {
  const api = getFreellmApi();
  const [state, setState] = useState<UpdateStateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<'csv' | 'jsonl'>('csv');
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [wipeDone, setWipeDone] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useProfileChanges(() => setReloadKey((v) => v + 1));

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setState(await api.update.getState());
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  const phase = state?.phase ?? 'unsupported';
  const downloading = phase === 'downloading';

  // 下载中每秒轮询一次进度; 其余状态不需要循环。
  useEffect(() => {
    if (!downloading || !api) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [downloading, refresh, api]);

  if (!api) return null;

  const phaseText: Record<string, string> = {
    idle: '未检查',
    checking: '检查中…',
    'not-available': '已是最新版本',
    available: '发现新版本',
    downloading: '下载中…',
    ready: '更新已就绪，重启后生效',
    error: '检查失败',
    unsupported: '开发模式下不可用（打包后才可自动更新）',
  };

  return (
    <div className="card card-hover mb-4">
      <h3 className="text-sm font-semibold text-surface-800 mb-3">应用更新</h3>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="badge-gray">当前 v{state?.currentVersion ?? '?'}</span>
        <span className="badge-blue">{phaseText[phase] ?? phase}</span>
        {state?.version && (phase === 'available' || phase === 'ready' || phase === 'downloading') && (
          <span className="text-surface-500">→ v{state.version}</span>
        )}
        {downloading && state?.percent !== null && state?.percent !== undefined && (
          <span className="text-surface-500 tabular-nums">{state.percent}%</span>
        )}
      </div>
      {downloading && state?.percent !== null && state?.percent !== undefined && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-100">
          <div className="h-full bg-primary-600" style={{ width: `${state.percent}%` }} />
        </div>
      )}
      {state?.error && <div className="mt-2 text-[11px] text-red-600">{state.error}</div>}
      {message && <div className="mt-2 text-[11px] text-surface-500">{message}</div>}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={busy || downloading}
          onClick={async () => {
            setBusy(true);
            setMessage(null);
            try {
              const result = await api.update.check();
              setState(result);
              if (result.phase === 'available') {
                setState(await api.update.download());
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '检查中…' : '检查更新'}
        </button>
        {phase === 'ready' && (
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={async () => {
              await api.update.install();
            }}
          >
            重启并安装{state?.version ? ` v${state.version}` : ''}
          </button>
        )}
      </div>

      <div className="mt-4 border-t border-surface-100 pt-3">
        <h4 className="text-xs font-semibold text-surface-700 mb-2">数据管理</h4>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            className="input-field min-w-24"
            value={exportFormat}
            onChange={(event) => setExportFormat(event.target.value as 'csv' | 'jsonl')}
          >
            <option value="csv">CSV</option>
            <option value="jsonl">JSONL</option>
          </select>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={async () => {
              if (!api) return;
              const result = (await api.usage.exportLogs({ format: exportFormat })) as {
                format: string;
                content: string;
              };
              const blob = new Blob([result.content], {
                type: result.format === 'jsonl' ? 'application/x-ndjson' : 'text/csv;charset=utf-8',
              });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = `freellm-hub-calls-${new Date().toISOString().slice(0, 10)}.${result.format}`;
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            导出调用记录
          </button>
          {!wipeConfirm ? (
            <button type="button" className="btn-ghost text-xs" onClick={() => setWipeConfirm(true)}>
              清空当前配置档数据…
            </button>
          ) : (
            <>
              <span className="text-[11px] text-red-600">
                将删除调用记录、审计轨迹与配额计数（不影响服务商配置）。
              </span>
              <button
                type="button"
                className="btn-danger text-xs"
                onClick={async () => {
                  const result = (await api.usage.wipeData({})) as Record<string, number>;
                  setWipeDone(Object.values(result).reduce((sum, n) => sum + Number(n ?? 0), 0));
                  setWipeConfirm(false);
                  setReloadKey((v) => v + 1);
                }}
              >
                确认清空
              </button>
              <button type="button" className="btn-ghost text-xs" onClick={() => setWipeConfirm(false)}>
                取消
              </button>
            </>
          )}
        </div>
        {wipeDone !== null && (
          <div className="mt-2 text-[11px] text-surface-500">已清除 {wipeDone} 行数据。</div>
        )}
      </div>
    </div>
  );
}

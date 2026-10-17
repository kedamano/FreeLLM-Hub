import { useState } from 'react';

export interface NewProviderDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
}

interface AddCustomProviderDialogProps {
  creating: boolean;
  onClose: () => void;
  onSubmit: (draft: NewProviderDraft) => void;
}

const BASE_URL_PATTERN = /^https?:\/\/\S+$/i;

/** Rejects an empty name or a URL that is not http(s) before anything reaches the backend. */
export function validateNewProviderDraft(draft: NewProviderDraft): string | null {
  if (!draft.name) return '请填写名称和以 http(s):// 开头的 Base URL';
  if (!BASE_URL_PATTERN.test(draft.baseUrl)) return '请填写名称和以 http(s):// 开头的 Base URL';
  return null;
}

/**
 * Draft form for an OpenAI-compatible endpoint. It holds only what the user typed: the
 * create call and its validation live in the page, so a rejected draft stays on screen.
 */
export default function AddCustomProviderDialog({
  creating,
  onClose,
  onSubmit,
}: AddCustomProviderDialogProps) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  const submit = () => {
    onSubmit({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
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
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：我的中转站"
        />
        <label className="label">Base URL</label>
        <input
          className="input-field mb-3 font-mono text-xs"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
        />
        <label className="label">API Key（可选，可稍后配置）</label>
        <input
          type="password"
          className="input-field mb-4 font-mono text-xs"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary text-xs">
            取消
          </button>
          <button onClick={submit} disabled={creating} className="btn-primary text-xs">
            {creating ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';

interface ProviderInfo {
  id: string;
  displayName: string;
  authType: string;
  baseUrl: string;
  isEnabled: boolean;
  isBuiltIn: boolean;
  credentialStatus: string;
  hasCredential: boolean;
  metadata?: { description?: string };
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [credentialInput, setCredentialInput] = useState('');

  useEffect(() => {
    loadProviders();
  }, []);

  async function loadProviders() {
    setLoading(true);
    try {
      const result = await (
        window as unknown as {
          freellm: { providers: { list: () => Promise<ProviderInfo[]> } };
        }
      ).freellm.providers.list();
      setProviders(result);
    } catch {
      setProviders(getMockProviders());
    }
    setLoading(false);
  }

  async function handleTest(providerId: string) {
    try {
      const result = await (
        window as unknown as {
          freellm: {
            providers: {
              test: (id: string) => Promise<{ success: boolean; error?: string }>;
            };
          };
        }
      ).freellm.providers.test(providerId);
      alert(result.success ? '连接成功' : `连接失败: ${result.error}`);
    } catch {
      alert('测试失败');
    }
  }

  async function handleSaveCredential(providerId: string) {
    try {
      await (
        window as unknown as {
          freellm: {
            providers: {
              setCredential: (id: string, cred: string) => Promise<{ success: boolean }>;
            };
          };
        }
      ).freellm.providers.setCredential(providerId, credentialInput);
      setEditingId(null);
      setCredentialInput('');
      loadProviders();
    } catch {
      alert('保存失败');
    }
  }

  async function handleToggle(providerId: string, enabled: boolean) {
    try {
      await (
        window as unknown as {
          freellm: {
            providers: {
              toggle: (id: string, e: boolean) => Promise<{ success: boolean }>;
            };
          };
        }
      ).freellm.providers.toggle(providerId, enabled);
      loadProviders();
    } catch {
      // ignore
    }
  }

  if (loading) {
    return <div className="text-center py-8 text-surface-500">加载中...</div>;
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-surface-900">服务商管理</h2>
        <p className="text-sm text-surface-500 mt-1">
          管理大模型服务商的接入凭证和状态
        </p>
      </div>

      <div className="space-y-3">
        {providers.map((provider) => (
          <div key={provider.id} className="card">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold text-white ${
                    provider.isEnabled ? 'bg-primary-500' : 'bg-surface-300'
                  }`}
                >
                  {provider.displayName.charAt(0)}
                </div>
                <div>
                  <div className="font-medium text-surface-900">
                    {provider.displayName}
                  </div>
                  <div className="text-xs text-surface-400">{provider.baseUrl}</div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {provider.hasCredential ? (
                  <span className="badge-green">已配置</span>
                ) : provider.authType === 'none' ? (
                  <span className="badge-blue">无需凭证</span>
                ) : (
                  <span className="badge-yellow">未配置</span>
                )}

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={provider.isEnabled}
                    onChange={(e) => handleToggle(provider.id, e.target.checked)}
                    className="w-4 h-4 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="text-xs text-surface-600">
                    {provider.isEnabled ? '已启用' : '已禁用'}
                  </span>
                </label>

                <button
                  onClick={() => handleTest(provider.id)}
                  className="btn-secondary text-xs px-2 py-1"
                >
                  测试
                </button>

                {provider.authType !== 'none' && (
                  <button
                    onClick={() => setEditingId(provider.id)}
                    className="btn-primary text-xs px-2 py-1"
                  >
                    {provider.hasCredential ? '更新' : '配置'}
                  </button>
                )}
              </div>
            </div>

            {editingId === provider.id && (
              <div className="mt-3 pt-3 border-t border-surface-100 flex items-center gap-2">
                <input
                  type="password"
                  value={credentialInput}
                  onChange={(e) => setCredentialInput(e.target.value)}
                  placeholder="输入 API Key 或 Token"
                  className="input-field flex-1"
                />
                <button
                  onClick={() => handleSaveCredential(provider.id)}
                  className="btn-primary text-xs"
                >
                  保存
                </button>
                <button
                  onClick={() => {
                    setEditingId(null);
                    setCredentialInput('');
                  }}
                  className="btn-secondary text-xs"
                >
                  取消
                </button>
              </div>
            )}

            {provider.metadata?.description && (
              <p className="text-xs text-surface-400 mt-2">
                {provider.metadata.description}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

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
      baseUrl: 'https://api.cloudflare.com/client/v4',
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
      isEnabled: false,
      isBuiltIn: true,
      credentialStatus: 'unconfigured',
      hasCredential: false,
      metadata: { description: 'HF Inference API 免费访问' },
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
  ];
}

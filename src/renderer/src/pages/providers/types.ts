import type { OAuthCredentialState } from '../../../../shared/types/observability.js';
import type { ModelCapabilities } from '../../../../shared/types/index.js';

export interface ProviderConfigFieldInfo {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  authType: 'api-key' | 'oauth' | 'none' | 'custom';
  baseUrl: string;
  isEnabled: boolean;
  isBuiltIn: boolean;
  credentialStatus: string;
  hasCredential: boolean;
  configFields?: ProviderConfigFieldInfo[];
  settings?: Record<string, unknown>;
  baseUrlDerived?: boolean;
  quota?: { maxRequestsPerDay?: number; maxTokensPerDay?: number };
  quotaRemaining?: { requests?: number; tokens?: number; unlimited: boolean };
  oauth?: OAuthCredentialState | null;
  metadata?: { description?: string };
}

export interface ProviderModel {
  id: string;
  displayName: string;
  description?: string;
  capabilities: ModelCapabilities;
  pricing: {
    type: string;
    currency: string;
    notes?: string;
  };
  status: string;
}

export interface CredentialSlot {
  index: number;
  keyId: string;
  masked: string;
}

export type ProviderGroup = 'local' | 'cloud' | 'custom';

export interface GroupDef {
  key: ProviderGroup;
  label: string;
  description: string;
}

export const PROVIDER_GROUPS: GroupDef[] = [
  { key: 'local', label: '本地服务', description: 'Ollama、LM Studio 等本地推理' },
  { key: 'cloud', label: '云端服务', description: 'Groq、Gemini 等免费云端 API' },
  { key: 'custom', label: '自定义服务', description: 'OpenAI 兼容的自定义供应商' },
];

export const LOCAL_PROVIDER_IDS = ['ollama', 'lmstudio'];

export function getProviderGroup(p: ProviderInfo): ProviderGroup {
  if (LOCAL_PROVIDER_IDS.includes(p.id)) return 'local';
  if (p.isBuiltIn) return 'cloud';
  return 'custom';
}

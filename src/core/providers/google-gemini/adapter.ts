import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';
import { credentialIdFor } from '../credential-keys.js';

export function createGoogleGeminiAdapter(apiKey?: string): OpenAICompatibleAdapter {
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';

  return new OpenAICompatibleAdapter({
    providerId: 'google-gemini',
    providerName: 'Google Gemini',
    baseUrl,
    authType: 'api-key',
    credentialId: credentialIdFor('google-gemini', apiKey),
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      {
        id: 'gemini-2.0-flash',
        providerId: 'google-gemini',
        displayName: 'Gemini 2.0 Flash',
        description: 'Google Gemini 2.0 Flash - fast multimodal model',
        capabilities: {
          supported: ['chat', 'completion', 'streaming', 'vision', 'function-calling', 'json-mode'],
          contextWindow: 1048576,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: true,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free tier: 15 RPM, 1M TPM' },
        rateLimits: { requestsPerMinute: 15, tokensPerMinute: 1000000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'gemini-2.5-flash',
        providerId: 'google-gemini',
        displayName: 'Gemini 2.5 Flash',
        description: 'Google Gemini 2.5 Flash - latest fast model',
        capabilities: {
          supported: ['chat', 'completion', 'streaming', 'vision', 'function-calling', 'json-mode'],
          contextWindow: 1048576,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: true,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
        },
        pricing: { type: 'freemium', currency: 'USD', notes: 'Free tier with limits' },
        rateLimits: { requestsPerMinute: 15, tokensPerMinute: 1000000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'gemini-2.0-flash-lite',
        providerId: 'google-gemini',
        displayName: 'Gemini 2.0 Flash Lite',
        description: 'Lightweight fast model for simple tasks',
        capabilities: {
          supported: ['chat', 'completion', 'streaming'],
          contextWindow: 1048576,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free tier: 30 RPM' },
        rateLimits: { requestsPerMinute: 30, tokensPerMinute: 1000000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}

import { z } from 'zod';

export const ModelCapabilitySchema = z.enum([
  'chat',
  'completion',
  'embedding',
  'vision',
  'function-calling',
  'json-mode',
  'streaming',
]);

export const AuthTypeSchema = z.enum(['api-key', 'oauth', 'none', 'custom']);

export const ModelPricingTypeSchema = z.enum(['free', 'freemium', 'paid', 'unknown', 'local']);

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  authType: AuthTypeSchema,
  baseUrl: z.string().url(),
  apiVersion: z.string().optional(),
  isEnabled: z.boolean(),
  isBuiltIn: z.boolean(),
  credentialStatus: z.enum(['unconfigured', 'configured', 'valid', 'invalid', 'expired']),
  credentialId: z.string().optional(),
  settings: z.record(z.unknown()).optional(),
  metadata: z
    .object({
      icon: z.string().optional(),
      docs: z.string().url().optional(),
      tos: z.string().url().optional(),
      description: z.string().optional(),
    })
    .optional(),
});

export const TaskTypeSchema = z.enum([
  'general',
  'coding',
  'analysis',
  'creative',
  'summarization',
  'classification',
  'extraction',
  'translation',
  'lightweight',
]);

export const GatewayMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      })
    )
    .optional(),
});

export const GatewayRequestSchema = z.object({
  requestId: z.string().min(1),
  messages: z.array(GatewayMessageSchema).min(1),
  model: z.string().optional(),
  taskType: TaskTypeSchema.optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.unknown()).optional(),
  responseFormat: z.object({ type: z.string() }).optional(),
});

export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  capabilities: z.object({
    supported: z.array(ModelCapabilitySchema),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive().optional(),
    supportsStreaming: z.boolean(),
    supportsVision: z.boolean(),
    supportsFunctionCalling: z.boolean(),
    supportsJsonMode: z.boolean(),
  }),
  pricing: z.object({
    type: ModelPricingTypeSchema,
    inputPricePer1M: z.number().nonnegative().optional(),
    outputPricePer1M: z.number().nonnegative().optional(),
    currency: z.string().default('USD'),
    notes: z.string().optional(),
  }),
  rateLimits: z
    .object({
      requestsPerMinute: z.number().int().positive().optional(),
      tokensPerMinute: z.number().int().positive().optional(),
    })
    .optional(),
  status: z.enum(['available', 'limited', 'unavailable', 'unknown']),
  discoveredAt: z.string(),
  lastCheckedAt: z.string().optional(),
});

export const SettingsSchema = z.object({
  gatewayHost: z.string().default('127.0.0.1'),
  gatewayPort: z.number().int().default(0),
  preferredTaskTypes: z.record(TaskTypeSchema).optional(),
  budgetLimit: z.number().nonnegative().optional(),
  autoFallback: z.boolean().default(true),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  language: z.string().default('zh-CN'),
});

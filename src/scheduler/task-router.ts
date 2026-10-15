import type { TaskType } from '../shared/types/index.js';
import type { ProviderModel } from '../shared/types/index.js';

export interface TaskRoute {
  taskType: TaskType;
  preferredProviders: string[];
  preferredModels: string[];
  minCapabilities: string[];
  priority: number;
}

const TASK_ROUTES: Record<TaskType, Omit<TaskRoute, 'taskType'>> = {
  general: {
    preferredProviders: ['ollama', 'local', 'groq', 'google-gemini', 'cloudflare'],
    preferredModels: [],
    minCapabilities: ['chat'],
    priority: 5,
  },
  coding: {
    preferredProviders: ['ollama', 'groq', 'google-gemini', 'cerebras', 'cloudflare'],
    preferredModels: ['llama-3.3-70b-versatile', 'gemini-2.0-flash'],
    minCapabilities: ['chat', 'streaming'],
    priority: 8,
  },
  analysis: {
    preferredProviders: ['ollama', 'groq', 'google-gemini', 'huggingface'],
    preferredModels: ['llama-3.3-70b-versatile', 'gemini-2.0-flash'],
    minCapabilities: ['chat', 'streaming'],
    priority: 7,
  },
  creative: {
    preferredProviders: ['ollama', 'groq', 'google-gemini', 'cloudflare'],
    preferredModels: [],
    minCapabilities: ['chat'],
    priority: 6,
  },
  summarization: {
    preferredProviders: ['cloudflare', 'groq', 'ollama', 'google-gemini'],
    preferredModels: [],
    minCapabilities: ['chat'],
    priority: 3,
  },
  classification: {
    preferredProviders: ['groq', 'ollama', 'cloudflare', 'google-gemini'],
    preferredModels: [],
    minCapabilities: ['chat', 'json-mode'],
    priority: 4,
  },
  extraction: {
    preferredProviders: ['groq', 'ollama', 'google-gemini', 'cloudflare'],
    preferredModels: [],
    minCapabilities: ['chat', 'json-mode'],
    priority: 4,
  },
  translation: {
    preferredProviders: ['cloudflare', 'groq', 'ollama', 'google-gemini'],
    preferredModels: [],
    minCapabilities: ['chat'],
    priority: 5,
  },
  lightweight: {
    preferredProviders: ['ollama', 'cloudflare', 'groq', 'huggingface'],
    preferredModels: [],
    minCapabilities: ['chat'],
    priority: 1,
  },
};

export function getTaskRoute(taskType: TaskType): TaskRoute {
  const route = TASK_ROUTES[taskType] || TASK_ROUTES.general;
  return { taskType, ...route };
}

export function getAllRoutes(): TaskRoute[] {
  return Object.keys(TASK_ROUTES).map((taskType) => getTaskRoute(taskType as TaskType));
}

export function scoreModelForTask(model: ProviderModel, taskType: TaskType): number {
  const route = getTaskRoute(taskType);
  let score = 0;

  const providerIndex = route.preferredProviders.indexOf(model.providerId);
  if (providerIndex !== -1) {
    score += (route.preferredProviders.length - providerIndex) * 10;
  } else {
    score -= 20;
  }

  if (route.preferredModels.includes(model.id)) {
    score += 30;
  }

  const hasAllCaps = route.minCapabilities.every((cap: string) =>
    model.capabilities.supported.includes(cap as never)
  );
  if (hasAllCaps) score += 20;
  else score -= 50;

  if (model.pricing.type === 'local') score += 25;
  else if (model.pricing.type === 'free') score += 15;
  else if (model.pricing.type === 'freemium') score += 5;

  return score;
}

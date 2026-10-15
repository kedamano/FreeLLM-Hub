import type { ProviderModel, TaskType, ModelCapability } from '../shared/types/index.js';

export interface FilterCriteria {
  taskType?: TaskType;
  requiredCapabilities?: ModelCapability[];
  minContextWindow?: number;
  preferFree?: boolean;
  excludeProviders?: string[];
  includeProviders?: string[];
  maxCostPerRequest?: number;
}

const TASK_CAPABILITY_MAP: Record<TaskType, ModelCapability[]> = {
  general: ['chat'],
  coding: ['chat', 'streaming'],
  analysis: ['chat', 'streaming'],
  creative: ['chat'],
  summarization: ['chat'],
  classification: ['chat', 'json-mode'],
  extraction: ['chat', 'json-mode'],
  translation: ['chat'],
  lightweight: ['chat'],
};

export function filterCandidates(
  models: ProviderModel[],
  criteria: FilterCriteria
  // eslint-disable-next-line @typescript-eslint/no-inferrable-types
): ProviderModel[] {
  const requiredCaps = criteria.requiredCapabilities || [
    ...(criteria.taskType ? TASK_CAPABILITY_MAP[criteria.taskType] || ['chat'] : ['chat']),
  ];

  return models.filter((model) => {
    if (model.status === 'unavailable') return false;

    if (criteria.excludeProviders?.includes(model.providerId)) return false;
    if (criteria.includeProviders && !criteria.includeProviders.includes(model.providerId)) {
      return false;
    }

    const hasAllCaps = requiredCaps.every((cap) => model.capabilities.supported.includes(cap));
    if (!hasAllCaps) return false;

    if (criteria.minContextWindow && model.capabilities.contextWindow < criteria.minContextWindow) {
      return false;
    }

    if (criteria.preferFree && model.pricing.type === 'paid') return false;

    return true;
  });
}

import { randomUUID } from 'node:crypto';

export function generateId(): string {
  return randomUUID();
}

export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;

  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;

  return Math.ceil(chineseChars * 1.5 + otherChars / 4 + words * 0.3);
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string | null }>
): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.content) {
      total += estimateTokens(msg.content);
    }
    total += 4;
  }
  total += 2;
  return total;
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return text.slice(0, low);
}

export class TokenCounter {
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalTokens = 0;
  private requestCount = 0;

  record(promptTokens: number, completionTokens: number): void {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalTokens += promptTokens + completionTokens;
    this.requestCount += 1;
  }

  getStats() {
    return {
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalTokens,
      requestCount: this.requestCount,
      avgTokensPerRequest: this.requestCount > 0 ? this.totalTokens / this.requestCount : 0,
    };
  }

  reset(): void {
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalTokens = 0;
    this.requestCount = 0;
  }
}

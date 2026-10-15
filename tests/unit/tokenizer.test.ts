import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessagesTokens, truncateToTokenLimit, TokenCounter } from '../../src/usage/tokenizer';

describe('tokenizer', () => {
  describe('estimateTokens', () => {
    it('should return 0 for empty text', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate tokens for English text', () => {
      const tokens = estimateTokens('Hello world');
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle Chinese characters', () => {
      const tokens = estimateTokens('你好世界');
      expect(tokens).toBeGreaterThan(0);
    });

    it('should scale with text length', () => {
      const shortTokens = estimateTokens('Hi');
      const longTokens = estimateTokens('A'.repeat(1000));
      expect(longTokens).toBeGreaterThan(shortTokens);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('should calculate tokens for a message array', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      const tokens = estimateMessagesTokens(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle null content', () => {
      const messages = [{ role: 'user', content: null }];
      const tokens = estimateMessagesTokens(messages);
      expect(tokens).toBeGreaterThanOrEqual(0);
    });
  });

  describe('truncateToTokenLimit', () => {
    it('should not truncate text within limit', () => {
      const text = 'Hello world';
      const result = truncateToTokenLimit(text, 50);
      expect(result).toBe(text);
    });

    it('should truncate text exceeding limit', () => {
      const text = 'A B C D E F G H I J K L M N O P';
      const result = truncateToTokenLimit(text, 3);
      expect(result.length).toBeLessThan(text.length);
    });
  });

  describe('TokenCounter', () => {
    it('should track token usage', () => {
      const counter = new TokenCounter();
      counter.record(100, 50);
      counter.record(200, 80);

      const stats = counter.getStats();
      expect(stats.totalPromptTokens).toBe(300);
      expect(stats.totalCompletionTokens).toBe(130);
      expect(stats.totalTokens).toBe(430);
      expect(stats.requestCount).toBe(2);
      expect(stats.avgTokensPerRequest).toBe(215);
    });

    it('should reset correctly', () => {
      const counter = new TokenCounter();
      counter.record(100, 50);
      counter.reset();

      const stats = counter.getStats();
      expect(stats.totalTokens).toBe(0);
      expect(stats.requestCount).toBe(0);
    });

    it('should handle zero requests', () => {
      const counter = new TokenCounter();
      const stats = counter.getStats();
      expect(stats.avgTokensPerRequest).toBe(0);
    });
  });
});

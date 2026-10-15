import { describe, it, expect } from 'vitest';
import { redactSecrets, redactObject, safeStringify } from '../../src/main/security/secret-redaction';

describe('secret-redaction', () => {
  describe('redactSecrets', () => {
    it('should return empty string unchanged', () => {
      expect(redactSecrets('')).toBe('');
    });

    it('should redact Bearer token', () => {
      const result = redactSecrets('Authorization: Bearer abc123xyz789secret');
      expect(result).not.toContain('abc123xyz789secret');
      expect(result).toContain('****');
    });

    it('should redact api_key patterns', () => {
      const result = redactSecrets('api_key: sk-abc123def456ghi789');
      expect(result).toContain('****');
    });

    it('should redact token patterns', () => {
      const result = redactSecrets('token=supersecrettoken12345');
      expect(result).toContain('****');
    });

    it('should not modify clean text', () => {
      const text = 'This is a normal log message without secrets';
      expect(redactSecrets(text)).toBe(text);
    });

    it('should handle multiple secrets in one string', () => {
      const input = 'Authorization: Bearer mytoken123 blah Authorization: Bearer anothertoken456';
      const result = redactSecrets(input);
      expect(result).not.toContain('mytoken123');
      expect(result).not.toContain('anothertoken456');
      expect(result).toContain('****');
    });

    it('should handle null/undefined input', () => {
      expect(redactSecrets(null as unknown as string)).toBe(null);
    });
  });

  describe('redactObject', () => {
    it('should redact key fields', () => {
      const obj = { apiKey: 'secret123', name: 'test' };
      const result = redactObject(obj);
      expect(result.apiKey).toBe('****');
      expect(result.name).toBe('test');
    });

    it('should redact token fields', () => {
      const obj = { accessToken: 'tok_abc123', data: 'visible' };
      const result = redactObject(obj);
      expect(result.accessToken).toBe('****');
      expect(result.data).toBe('visible');
    });

    it('should redact password fields', () => {
      const obj = { password: 'hunter2', username: 'admin' };
      const result = redactObject(obj);
      expect(result.password).toBe('****');
      expect(result.username).toBe('admin');
    });

    it('should not redact short values', () => {
      const obj = { key: 'ab', token: '123' };
      const result = redactObject(obj);
      expect(result.key).toBe('ab');
      expect(result.token).toBe('123');
    });

    it('should not mutate original object', () => {
      const obj = { apiKey: 'secret123' };
      const original = { ...obj };
      redactObject(obj);
      expect(obj.apiKey).toBe(original.apiKey);
    });
  });

  describe('safeStringify', () => {
    it('should stringify and redact secrets', () => {
      const obj = { apiKey: 'visible-secret-key', data: 'safe' };
      const result = safeStringify(obj);
      expect(result).toContain('****');
      expect(result).not.toContain('visible-secret-key');
    });

    it('should handle unserializable objects', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = safeStringify(circular);
      expect(result).toBe('[Unserializable Object]');
    });
  });
});

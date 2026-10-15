const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+/g,
  /api[_-]?key["\s:=]+[A-Za-z0-9\-._~+/]{8,}/gi,
  /token["\s:=]+[A-Za-z0-9\-._~+/]{8,}/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /["']?(?:password|secret|api_?key|token)["']?\s*[:=]\s*["']?([A-Za-z0-9\-._~+/]{8,})["']?/gi,
  /Authorization:\s*Bearer\s+\S+/gi,
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text;

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.includes(':') || match.includes('=') || match.includes('Bearer')) {
        const prefix = match.slice(0, Math.max(0, match.length - 8));
        return `${prefix}****`;
      }
      return '****';
    });
  }

  return result;
}

export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj };

  for (const key of Object.keys(result)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('key') ||
      lowerKey.includes('token') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('password') ||
      lowerKey.includes('credential')
    ) {
      const value = result[key];
      if (typeof value === 'string' && value.length > 4) {
        result[key] = ('****' as unknown) as T[Extract<keyof T, string>];
      }
    }
  }

  return result;
}

export function safeStringify(obj: unknown): string {
  try {
    const str = JSON.stringify(obj);
    return redactSecrets(str);
  } catch {
    return '[Unserializable Object]';
  }
}

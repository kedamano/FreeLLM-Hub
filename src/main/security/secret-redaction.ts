const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+([A-Za-z0-9\-._~+/]{4,})/gi,
  /(?:api[_-]?key|secret|token|password|credential)["'\s:=]{1,4}([A-Za-z0-9\-._~+/]{4,})/gi,
  /(sk-[A-Za-z0-9]{16,})/g,
];

const PREFIX_LENGTH = 4;

function maskSecret(match: string, secret: string | undefined): string {
  const value = typeof secret === 'string' && secret.length > 0 ? secret : match;
  const head = secret === undefined ? '' : match.slice(0, match.length - value.length);
  return `${head}${value.slice(0, PREFIX_LENGTH)}****`;
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text;

  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match: string, group?: string) =>
      maskSecret(match, typeof group === 'string' ? group : undefined)
    );
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
        (result as Record<string, unknown>)[key] = '****';
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

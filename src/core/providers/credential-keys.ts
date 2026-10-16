/**
 * Single source of truth for provider credential identity.
 *
 * History: credential ids used to be hard-coded per adapter factory
 * (`google-key`, `hf-token`, `cloudflare-token`, ...) while the UI wrote
 * `<providerId>-key`. The two never met, so a key saved from the UI was silently
 * lost on the next launch. Everything now derives the id from the providerId and
 * legacy ids are migrated instead of being read from a second table of names.
 */

export const CREDENTIAL_KEY_SUFFIX = 'key';

/** Canonical secret-store id for a provider. */
export function credentialKeyFor(providerId: string): string {
  return `${providerId}-${CREDENTIAL_KEY_SUFFIX}`;
}

/**
 * `credentialId` value for adapter factories: only present when a credential
 * actually exists, so `credentialStatus` stays honest.
 */
export function credentialIdFor(
  providerId: string,
  credential?: string | null
): string | undefined {
  return credential ? credentialKeyFor(providerId) : undefined;
}

/** Secret-store ids written by older builds, in migration order. */
export const LEGACY_CREDENTIAL_KEYS: Record<string, string[]> = {
  'google-gemini': ['google-key'],
  huggingface: ['hf-token', 'huggingface-token'],
  cloudflare: ['cloudflare-token'],
};

export interface LegacyFieldMigration {
  /** Secret-store id that older builds used for a non-secret value. */
  legacyId: string;
  /** The legacy value is a JSON object whose keys map onto provider config. */
  json?: boolean;
}

/**
 * Older builds stored plain configuration (Cloudflare account id, Ollama base URL)
 * inside the encrypted credential store under ids that are not credentials.
 */
export const LEGACY_FIELD_MIGRATIONS: Record<string, LegacyFieldMigration[]> = {
  cloudflare: [{ legacyId: 'cloudflare-account' }],
  ollama: [{ legacyId: 'ollama-config', json: true }],
};

/** All ids that may hold this provider's credential, canonical first. */
export function credentialKeyCandidates(providerId: string): string[] {
  const legacy = LEGACY_CREDENTIAL_KEYS[providerId] ?? [];
  return [credentialKeyFor(providerId), ...legacy.filter((id) => id !== credentialKeyFor(providerId))];
}

export interface SecretKeyStore {
  retrieve(id: string): string | null;
  store(id: string, value: string): void;
  delete(id: string): boolean;
}

export interface ResolvedCredential {
  credential: string | null;
  /** Id the credential was found under; equals the canonical id once migrated. */
  keyUsed: string | null;
  migrated: boolean;
}

/**
 * Read a provider credential, lazily copying a legacy id onto the canonical one.
 * `safeStorage` may be unavailable (locked machine); migration failures then just
 * leave the legacy id in place and still return a working credential.
 */
export function resolveProviderCredential(
  store: SecretKeyStore,
  providerId: string
): ResolvedCredential {
  const canonical = credentialKeyFor(providerId);
  for (const key of credentialKeyCandidates(providerId)) {
    let value: string | null = null;
    try {
      value = store.retrieve(key);
    } catch {
      value = null;
    }
    if (!value) continue;

    if (key === canonical) return { credential: value, keyUsed: key, migrated: false };

    try {
      store.store(canonical, value);
      store.delete(key);
      return { credential: value, keyUsed: canonical, migrated: true };
    } catch {
      return { credential: value, keyUsed: key, migrated: false };
    }
  }

  return { credential: null, keyUsed: null, migrated: false };
}

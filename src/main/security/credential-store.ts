import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDatabase } from '../../core/database/database.js';
import { getAppConfig, isElectronRuntime } from '../../core/config/app-config.js';

const CREDENTIAL_TABLE = `
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    encrypted_value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export interface Encryptor {
  available(): boolean;
  /** Returns the exact string persisted in the credentials table. */
  encrypt(value: string): string;
  /** Returns null when the envelope cannot be decrypted. */
  decrypt(stored: string): string | null;
}

interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(buffer: Buffer): string;
}

function getSafeStorage(): ElectronSafeStorage {
  // Lazy require: importing 'electron' at module top would crash plain Node.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { safeStorage } = require('electron') as { safeStorage: ElectronSafeStorage };
  return safeStorage;
}

class ElectronEncryptor implements Encryptor {
  available(): boolean {
    return getSafeStorage().isEncryptionAvailable();
  }

  encrypt(value: string): string {
    return getSafeStorage().encryptString(value).toString('base64');
  }

  decrypt(stored: string): string | null {
    try {
      return getSafeStorage().decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return null;
    }
  }
}

const KEY_FILE = 'credentials.key';
const ENVELOPE_PREFIX = 'v1';

class NodeAesGcmEncryptor implements Encryptor {
  private key: Buffer | null = null;

  available(): boolean {
    try {
      this.ensureKey();
      return true;
    } catch {
      return false;
    }
  }

  encrypt(value: string): string {
    const key = this.ensureKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(stored: string): string | null {
    try {
      const parts = stored.split(':');
      if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) return null;
      const key = this.ensureKey();
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const ciphertext = Buffer.from(parts[3], 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private ensureKey(): Buffer {
    if (this.key) return this.key;
    const keyPath = resolve(getAppConfig().dataDir, KEY_FILE);
    if (existsSync(keyPath)) {
      const key = readFileSync(keyPath);
      if (key.length === 32) {
        this.key = key;
        return key;
      }
    }
    const key = randomBytes(32);
    writeFileSync(keyPath, key, { mode: 0o600 });
    this.key = key;
    return key;
  }
}

export type CredentialKind =
  | 'api-key'
  | 'oauth'
  | 'oauth-client-secret'
  | 'bootstrap-token'
  | 'gateway-token';

export type CredentialLifecycleStatus =
  | 'active'
  | 'expired'
  | 'revoked'
  | 'refreshing'
  | 'error';

/**
 * Non-secret attributes about a stored secret. OAuth access tokens need these: the
 * UI has to show "expires in 42 minutes" and the refresher needs to know whether a
 * refresh token even exists, without decrypting the token on every read.
 */
export interface CredentialMetadata {
  kind?: CredentialKind;
  providerId?: string;
  tokenType?: string;
  scope?: string;
  /** ISO timestamp; only meaningful for `oauth`. */
  expiresAt?: string | null;
  refreshable?: boolean;
  status?: CredentialLifecycleStatus;
  lastRefreshedAt?: string | null;
  label?: string | null;
}

/** Raw `credentials` row shape, before the camelCase mapping. */
interface CredentialMetaRow {
  kind: string | null;
  provider_id: string | null;
  token_type: string | null;
  scope: string | null;
  expires_at: string | null;
  refreshable: number | null;
  status: string | null;
  last_refreshed_at: string | null;
  label: string | null;
}

export class CredentialStore {
  constructor(private encryptor: Encryptor) {
    const db = getDatabase();
    db.exec(CREDENTIAL_TABLE);
  }

  store(id: string, value: string): void {
    this.storeWithMetadata(id, value, {});
  }

  /**
   * Persist a secret together with its metadata. The metadata columns were added by
   * migration v6, so every write also has to work against a database that has not
   * been migrated yet (older builds) — the fallback insert keeps that path alive.
   */
  storeWithMetadata(id: string, value: string, meta: CredentialMetadata): void {
    if (!this.encryptor.available()) {
      throw new Error('Secure storage is not available on this system');
    }

    const db = getDatabase();
    const encrypted = this.encryptor.encrypt(value);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO credentials
           (id, encrypted_value, kind, provider_id, token_type, scope, expires_at, refreshable,
            status, last_refreshed_at, label, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        id,
        encrypted,
        meta.kind ?? 'api-key',
        meta.providerId ?? null,
        meta.tokenType ?? null,
        meta.scope ?? null,
        meta.expiresAt ?? null,
        meta.refreshable ? 1 : 0,
        meta.status ?? 'active',
        meta.lastRefreshedAt ?? null,
        meta.label ?? null
      );
    } catch {
      db.prepare(
        'INSERT OR REPLACE INTO credentials (id, encrypted_value, updated_at) VALUES (?, ?, datetime(\'now\'))'
      ).run(id, encrypted);
    }
  }

  /** Read metadata only — never decrypts, so it is cheap enough for list views. */
  readMetadata(id: string): CredentialMetadata | null {
    try {
      const row = getDatabase()
        .prepare(
          `SELECT kind, provider_id, token_type, scope, expires_at, refreshable, status,
                  last_refreshed_at, label
           FROM credentials WHERE id = ?`
        )
        .get(id) as CredentialMetaRow | undefined;
      if (!row) return null;
      return {
        kind: (row.kind ?? 'api-key') as CredentialMetadata['kind'],
        providerId: row.provider_id ?? undefined,
        tokenType: row.token_type ?? undefined,
        scope: row.scope ?? undefined,
        expiresAt: row.expires_at ?? null,
        refreshable: Number(row.refreshable ?? 0) === 1,
        status: (row.status ?? 'active') as CredentialMetadata['status'],
        lastRefreshedAt: row.last_refreshed_at ?? null,
        label: row.label ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Flip the status column, e.g. marking a token `expired` after a failed refresh. */
  updateStatus(id: string, status: NonNullable<CredentialMetadata['status']>): void {
    try {
      getDatabase()
        .prepare(
          "UPDATE credentials SET status = ?, updated_at = datetime('now') WHERE id = ?"
        )
        .run(status, id);
    } catch {
      /* pre-migration database: status is simply not trackable yet */
    }
  }

  retrieve(id: string): string | null {
    if (!this.encryptor.available()) {
      throw new Error('Secure storage is not available on this system');
    }

    const db = getDatabase();
    const stmt = db.prepare('SELECT encrypted_value FROM credentials WHERE id = ?');
    const row = stmt.get(id) as { encrypted_value: string } | undefined;

    if (!row) return null;
    return this.encryptor.decrypt(row.encrypted_value);
  }

  delete(id: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM credentials WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  has(id: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare('SELECT 1 FROM credentials WHERE id = ?');
    return !!stmt.get(id);
  }

  list(): string[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT id FROM credentials');
    const rows = stmt.all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  isAvailable(): boolean {
    return this.encryptor.available();
  }
}

function createEncryptor(): Encryptor {
  return isElectronRuntime() ? new ElectronEncryptor() : new NodeAesGcmEncryptor();
}

let instance: CredentialStore | null = null;

export function getCredentialStore(): CredentialStore {
  if (!instance) {
    instance = new CredentialStore(createEncryptor());
  }
  return instance;
}

export function resetCredentialStore(): void {
  instance = null;
}

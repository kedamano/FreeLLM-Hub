import { safeStorage } from 'electron';
import { getDatabase } from '../../core/database/database.js';

const CREDENTIAL_TABLE = `
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    encrypted_value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export class CredentialStore {
  constructor() {
    const db = getDatabase();
    db.exec(CREDENTIAL_TABLE);
  }

  store(id: string, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system');
    }

    const db = getDatabase();
    const encrypted = safeStorage.encryptString(value);
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO credentials (id, encrypted_value, updated_at) VALUES (?, ?, datetime('now'))`
    );
    stmt.run(id, encrypted.toString('base64'));
  }

  retrieve(id: string): string | null {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system');
    }

    const db = getDatabase();
    const stmt = db.prepare('SELECT encrypted_value FROM credentials WHERE id = ?');
    const row = stmt.get(id) as { encrypted_value: string } | undefined;

    if (!row) return null;

    try {
      const buffer = Buffer.from(row.encrypted_value, 'base64');
      return safeStorage.decryptString(buffer);
    } catch {
      return null;
    }
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
    return safeStorage.isEncryptionAvailable();
  }
}

let instance: CredentialStore | null = null;

export function getCredentialStore(): CredentialStore {
  if (!instance) {
    instance = new CredentialStore();
  }
  return instance;
}

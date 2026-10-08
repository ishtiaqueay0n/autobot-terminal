import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/** Encryption by the operating system's key store; `available` is false when there is none. */
export interface Encryptor {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/** Electron's safeStorage: DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux. */
export function safeStorageEncryptor(safeStorage: Electron.SafeStorage): Encryptor {
  return {
    // Without a keyring, Linux falls back to a hard-coded password ("basic_text"): that is not storage
    // a key should go into, so it counts as unavailable.
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };
}

export type KeySource = 'keychain' | 'env';

const NO_KEY_STORE =
  process.platform === 'linux'
    ? 'No keyring (Secret Service) was found to keep the key safe. Start GNOME Keyring, KWallet or KeePassXC, or start Autobot from a terminal with ANTHROPIC_API_KEY set.'
    : 'This system has no OS key store to keep the key safe. Set ANTHROPIC_API_KEY in your environment instead.';

/**
 * The Claude API key: stored encrypted by the OS in a file only this user can read, or taken from the
 * ANTHROPIC_API_KEY environment variable. It is never written in plain text and never sent to the window.
 */
export class KeyStore {
  private cached: string | null | undefined;

  constructor(
    private readonly file: string,
    private readonly crypto: Encryptor,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  canStore(): boolean {
    try {
      return this.crypto.available();
    } catch {
      return false;
    }
  }

  get(): { key: string; source: KeySource } | null {
    const stored = this.stored();
    if (stored) return { key: stored, source: 'keychain' };
    const fromEnv = this.env.ANTHROPIC_API_KEY?.trim();
    return fromEnv ? { key: fromEnv, source: 'env' } : null;
  }

  /** Saves a key (an empty string removes the stored one). Throws when the OS cannot encrypt it. */
  set(key: string): void {
    const value = key.trim();
    if (!value) {
      this.clear();
      return;
    }
    if (/\s/.test(value) || value.length < 20 || value.length > 400) throw new Error('That does not look like an API key.');
    if (!this.canStore()) {
      throw new Error(NO_KEY_STORE);
    }
    writeFileSync(this.file, this.crypto.encrypt(value), { mode: 0o600 });
    this.cached = value;
  }

  clear(): void {
    rmSync(this.file, { force: true });
    this.cached = null;
  }

  private stored(): string | null {
    if (this.cached !== undefined) return this.cached;
    this.cached = null;
    try {
      if (existsSync(this.file) && this.canStore()) this.cached = this.crypto.decrypt(readFileSync(this.file)) || null;
    } catch (err) {
      console.error('[ai] the stored API key could not be decrypted:', err);
    }
    return this.cached;
  }
}

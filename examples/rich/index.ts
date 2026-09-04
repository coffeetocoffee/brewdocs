/** A user identifier, trivially wrapping a string. */
export type UserId = string;

/** A key-value store. */
export type Dict<T> = { [key: string]: T };

/** Options for opening a {@link Vault}. */
export interface VaultOptions {
  /** Path to the vault file. */
  path: string;
  /** Cipher used for the vault. */
  cipher?: "aes-256-gcm" | "chacha20-poly1305";
  /**
   * Milliseconds before the vault auto-locks. Use `Infinity` to disable.
   * @default 300000
   */
  timeout?: number;
}

/** A secret vault. */
export class Vault<T extends VaultOptions = VaultOptions> {
  /** Whether the vault is currently unlocked. */
  readonly unlocked: boolean = false;

  /**
   * Create a vault.
   *
   * @param root - directory holding the vault file
   */
  constructor(root: string) {}

  /**
   * Open the vault.
   *
   * @param opts - vault configuration
   * @returns the number of secrets loaded
   * @throws {VaultError} when the vault file is missing or corrupt
   * @throws when the passphrase is wrong
   * @see Vault.unlockSync for the synchronous variant
   * @example
   * const vault = new Vault(opts);
   * await vault.open(opts);
   */
  async open(opts: T): Promise<number> {
    return 0;
  }

  /** Synchronous open.
   * @throws {VaultError} on corrupt files
   */
  unlockSync(path: string): void {}

  /** Lock the vault immediately. */
  static createDefault(): Vault {
    return new Vault();
  }
}

/**
 * Load a vault from disk.
 *
 * @param id - vault identifier
 * @param opts - extra vault options
 * @returns the number of secrets loaded
 * @throws {VaultError} when the vault file is missing or corrupt
 * @throws when the passphrase is wrong
 * @see Vault for full lifecycle control
 * @example
 * await openVault("main");
 */
export async function openVault<T extends VaultOptions>(id: UserId, opts?: T): Promise<number> {
  return 0;
}

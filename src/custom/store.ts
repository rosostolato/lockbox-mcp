/**
 * Saved destinations (docs/specs/custom-destinations, REQ-013…REQ-017, NFR-005).
 *
 * A destination the human approved and chose to keep, by name. Each entry is
 * pinned to the hash of its canonical JSON: on every read the hash is
 * recomputed, and an entry whose content no longer matches is reported as
 * changed, never trusted. The file is written only by Lockbox, atomically, mode
 * 0600 in a 0700 directory. An agent with a shell running as the same user can
 * still rewrite it whole — content and hash — which the spec records as out of
 * reach; what this file cannot do is silently pass off an edit as approved.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LockboxConfig } from '../config.js';
import { canonicalize, definitionHash, parseDefinition } from './definition.js';

export const SAVED_NAME = /^[a-z0-9-]{1,40}$/;

export interface SavedEntry {
  readonly name: string;
  readonly definition: unknown;
  readonly hash: string;
  readonly approvedAt: string;
  /** false when the stored content no longer matches the hash it was approved under. */
  readonly intact: boolean;
}

interface StoreFile {
  version: 1;
  destinations: Record<string, { hash: string; definition: unknown; approved_at: string }>;
}

export class SavedDestinations {
  constructor(readonly path: string) {}

  static for(config: LockboxConfig): SavedDestinations {
    return new SavedDestinations(config.customStorePath);
  }

  async list(): Promise<SavedEntry[]> {
    const file = await this.#read();
    return Object.entries(file.destinations)
      .filter(([name]) => SAVED_NAME.test(name))
      .map(([name, entry]) => ({
        name,
        definition: entry.definition,
        hash: entry.hash,
        approvedAt: entry.approved_at,
        intact: intact(entry.definition, entry.hash),
      }));
  }

  async get(name: string): Promise<SavedEntry | undefined> {
    return (await this.list()).find((entry) => entry.name === name);
  }

  /** The intact entry whose definition has this hash, if the human saved it. */
  async byHash(hash: string): Promise<SavedEntry | undefined> {
    return (await this.list()).find((entry) => entry.intact && entry.hash === hash);
  }

  /** Hosts of intact, saved http destinations: no longer "first time". */
  async knownHosts(): Promise<Set<string>> {
    const hosts = new Set<string>();
    for (const entry of await this.list()) {
      const definition = entry.definition as { kind?: unknown; url?: unknown };
      if (!entry.intact || definition.kind !== 'http' || typeof definition.url !== 'string') {
        continue;
      }
      try {
        hosts.add(new URL(definition.url).hostname.toLowerCase());
      } catch {
        // An unparsable URL is simply not a known host.
      }
    }
    return hosts;
  }

  async save(name: string, canonicalJson: string, hash: string): Promise<void> {
    if (!SAVED_NAME.test(name)) throw new Error('invalid saved destination name');
    const file = await this.#read();
    file.destinations[name] = {
      hash,
      definition: JSON.parse(canonicalJson) as unknown,
      approved_at: new Date().toISOString(),
    };
    await this.#write(file);
  }

  async remove(name: string): Promise<boolean> {
    const file = await this.#read();
    if (!(name in file.destinations)) return false;
    delete file.destinations[name];
    await this.#write(file);
    return true;
  }

  async #read(): Promise<StoreFile> {
    let raw: string;
    try {
      const handle = await fs.open(this.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        raw = await handle.readFile({ encoding: 'utf8' });
      } finally {
        await handle.close();
      }
    } catch {
      return { version: 1, destinations: {} };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      if (parsed.version === 1 && parsed.destinations && typeof parsed.destinations === 'object') {
        return { version: 1, destinations: { ...parsed.destinations } };
      }
    } catch {
      // A corrupt store holds nothing trustworthy.
    }
    return { version: 1, destinations: {} };
  }

  async #write(file: StoreFile): Promise<void> {
    const directory = dirname(this.path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(
      directory,
      `.destinations-${process.pid}-${Date.now().toString(36)}.tmp`,
    );
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8' });
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await fs.rename(temporary, this.path);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

/** Does the stored content still have the hash it was approved under? */
function intact(definition: unknown, hash: string): boolean {
  try {
    const parsed = parseDefinition(definition);
    return parsed.hash === hash && definitionHash(canonicalize(parsed.definition)) === hash;
  } catch {
    return false;
  }
}

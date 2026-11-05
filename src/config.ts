/**
 * Operator-controlled configuration.
 *
 * Configuration is read from the environment of the Lockbox process, which the
 * agent does not control. Nothing here can be influenced by MCP tool arguments —
 * an agent must not be able to relax a policy (SPEC.md §10).
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export const DEFAULT_PRODUCTION_MARKERS = ['prod', 'production', 'live', 'prd'] as const;
export const DEFAULT_STAGING_MARKERS = [
  'staging',
  'stage',
  'stg',
  'preprod',
  'pre-prod',
  'uat',
] as const;
export const DEFAULT_DEVELOPMENT_MARKERS = [
  'dev',
  'development',
  'local',
  'sandbox',
  'test',
  'testing',
] as const;

export const CUSTOM_KINDS = ['http', 'command', 'file'] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];
export type CustomDestinationsMode = 'once' | 'save';

export interface LockboxConfig {
  // Request lifetime
  readonly requestTtlSeconds: number;
  readonly maxActiveRequests: number;
  /**
   * Upper bound on a single adapter write, so a hung provider cannot pin a
   * request in EXECUTING (and therefore pin its secret in memory) forever.
   */
  readonly adapterTimeoutSeconds: number;

  // Confirmation policy (SPEC.md §10). Operators may only make this stricter.
  readonly stageBForMedium: boolean;
  readonly stageBForLow: boolean;

  // Secure UI
  readonly uiHost: string;
  readonly uiPort: number;
  /**
   * Open the authorization window on the user's machine. Keeping the URL out of
   * the agent's reach is what makes the window an out-of-band channel.
   */
  readonly openBrowser: boolean;
  /**
   * Return the authorization URL to the agent. OFF by default: the URL is a
   * capability, and an agent with network access could otherwise authorize its
   * own request without the human (SPEC.md §4.2, §7).
   */
  readonly discloseAuthorizationUrl: boolean;

  // `.env` adapter
  readonly envAllowedRoots: readonly string[];
  readonly allowGitTrackedEnv: boolean;
  /** Permit file names other than `.env` / `.env.<suffix>`. */
  readonly envAllowAnyFilename: boolean;

  // Destination gating (SPEC.md §16: arbitrary-network is off by default and is
  // not implemented at all in this version).
  readonly enabledAdapters?: readonly string[];

  // Destinations (docs/specs/custom-destinations). Every destination is defined
  // by the agent and approved by the human as rendered; the operator narrows it.
  /** `save` lets the human save an approved destination; `once` forces single use. */
  readonly customDestinations: CustomDestinationsMode;
  /** Kinds an agent may define; any subset of `http`, `command`, `file`. */
  readonly customKinds: readonly CustomKind[];
  /** Allowed `http` hosts, lowercased. Empty means any host, still reviewed. */
  readonly customHttpHosts: readonly string[];
  /** Permit `http` destinations that resolve to loopback, private or link-local addresses. */
  readonly customHttpAllowPrivate: boolean;
  /** Where approved destinations are saved; written only by Lockbox, mode 0600. */
  readonly customStorePath: string;

  // Environment classification
  readonly productionMarkers: readonly string[];
  readonly stagingMarkers: readonly string[];
  readonly developmentMarkers: readonly string[];
}

/**
 * Canonicalise a configured root, following symlinks.
 *
 * The `.env` adapter compares canonical paths, so the roots must be canonical
 * too — on macOS `/tmp` is a symlink to `/private/tmp`, and a lexical root
 * would reject every legitimate write beneath it.
 */
export function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function defaultConfig(overrides: Partial<LockboxConfig> = {}): LockboxConfig {
  return Object.freeze({
    requestTtlSeconds: 300,
    maxActiveRequests: 64,
    adapterTimeoutSeconds: 30,
    stageBForMedium: true,
    stageBForLow: false,
    uiHost: '127.0.0.1',
    uiPort: 0,
    openBrowser: true,
    discloseAuthorizationUrl: false,
    allowGitTrackedEnv: false,
    envAllowAnyFilename: false,
    customDestinations: 'save',
    customKinds: [...CUSTOM_KINDS],
    customHttpHosts: [],
    customHttpAllowPrivate: false,
    customStorePath: defaultStorePath(process.env),
    productionMarkers: [...DEFAULT_PRODUCTION_MARKERS],
    stagingMarkers: [...DEFAULT_STAGING_MARKERS],
    developmentMarkers: [...DEFAULT_DEVELOPMENT_MARKERS],
    ...overrides,
    envAllowedRoots: (overrides.envAllowedRoots ?? [canonicalRoot(process.cwd())]).map(
      canonicalRoot,
    ),
  });
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LockboxConfig {
  const roots = env.LOCKBOX_ENV_ALLOWED_ROOTS;
  return defaultConfig({
    requestTtlSeconds: clamp(number(env.LOCKBOX_REQUEST_TTL_SECONDS, 300), 15, 3600),
    maxActiveRequests: Math.trunc(number(env.LOCKBOX_MAX_ACTIVE_REQUESTS, 64)),
    adapterTimeoutSeconds: clamp(number(env.LOCKBOX_ADAPTER_TIMEOUT_SECONDS, 30), 1, 300),
    stageBForMedium: boolean(env.LOCKBOX_STAGE_B_FOR_MEDIUM, true),
    stageBForLow: boolean(env.LOCKBOX_STAGE_B_FOR_LOW, false),
    uiHost: env.LOCKBOX_UI_HOST ?? '127.0.0.1',
    uiPort: Math.trunc(number(env.LOCKBOX_UI_PORT, 0)),
    openBrowser: boolean(env.LOCKBOX_OPEN_BROWSER, true),
    discloseAuthorizationUrl: boolean(env.LOCKBOX_DISCLOSE_AUTHORIZATION_URL, false),
    envAllowedRoots: roots
      ? roots
          .split(delimiter)
          .filter((entry) => entry.length > 0)
          .map((entry) => canonicalRoot(entry))
      : [canonicalRoot(process.cwd())],
    allowGitTrackedEnv: boolean(env.LOCKBOX_ALLOW_GIT_TRACKED_ENV, false),
    envAllowAnyFilename: boolean(env.LOCKBOX_ENV_ALLOW_ANY_FILENAME, false),
    customDestinations: customMode(env.LOCKBOX_CUSTOM_DESTINATIONS),
    customKinds: env.LOCKBOX_CUSTOM_KINDS
      ? list(env.LOCKBOX_CUSTOM_KINDS).filter((kind): kind is CustomKind =>
          (CUSTOM_KINDS as readonly string[]).includes(kind),
        )
      : [...CUSTOM_KINDS],
    customHttpHosts: env.LOCKBOX_CUSTOM_HTTP_HOSTS ? list(env.LOCKBOX_CUSTOM_HTTP_HOSTS) : [],
    customHttpAllowPrivate: boolean(env.LOCKBOX_CUSTOM_HTTP_ALLOW_PRIVATE, false),
    customStorePath: env.LOCKBOX_CUSTOM_STORE_PATH
      ? resolve(env.LOCKBOX_CUSTOM_STORE_PATH)
      : defaultStorePath(env),
    ...(env.LOCKBOX_ENABLED_ADAPTERS
      ? {
          enabledAdapters: env.LOCKBOX_ENABLED_ADAPTERS.split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        }
      : {}),
  });
}

/** `$XDG_CONFIG_HOME/lockbox/destinations.json`, falling back to `~/.config`. */
function defaultStorePath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), '.config');
  return join(base, 'lockbox', 'destinations.json');
}

/** Only an exact `save` allows saving; anything else, including a typo, is the stricter `once`. */
function customMode(value: string | undefined): CustomDestinationsMode {
  if (value === undefined || value.trim() === '') return 'save';
  return value.trim().toLowerCase() === 'save' ? 'save' : 'once';
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

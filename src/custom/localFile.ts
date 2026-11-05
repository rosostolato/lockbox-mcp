/**
 * Local plaintext destinations: the protections every `file` definition gets
 * (SPEC.md §16, §33; docs/specs/custom-destinations REQ-008).
 *
 * Security properties implemented here:
 *
 * - the resolved path must stay inside an operator-configured root, and explicit
 *   `..` traversal is rejected outright;
 * - the target must not be a symlink, and the write is performed with `rename`,
 *   which replaces a link rather than writing through it, so a symlink planted
 *   between check and write still cannot redirect the credential;
 * - a git-tracked file is refused by default, and so is a new file git would not
 *   ignore;
 * - the write is atomic (temp file in the same directory, `0600`, `fsync`,
 *   rename), so an interrupted write cannot corrupt unrelated variables;
 * - the credential never appears in an argv: the only subprocess invoked is
 *   `git`, it is spawned without a shell, and it only ever receives paths.
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { adapterError } from '../adapters/base.js';
import type { LockboxConfig } from '../config.js';
import { ErrorCode } from '../errors.js';
import type { ValidationResult } from '../model.js';

const execFileAsync = promisify(execFile);

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const ENV_FILENAME_PATTERN = /^\.env(\.[A-Za-z0-9_.-]+)?$/;
const GIT_TIMEOUT_MS = 5_000;

/**
 * The canonical form of a directory, following symlinks.
 *
 * Missing directories are resolved as far as they exist, so a path under a
 * directory that has not been created yet is still checked against the real
 * location of its nearest existing ancestor.
 */
export function canonicalDirectory(directory: string): string {
  const absolute = resolve(directory);
  let head = absolute;
  const tail: string[] = [];

  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parsed = parse(head);
      if (parsed.dir === head) return absolute; // reached the filesystem root
      tail.push(parsed.base);
      head = parsed.dir;
    }
  }
}

function isWithin(path: string, root: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

async function fileExists(path: string): Promise<boolean> {
  return (await fs.lstat(path).catch(() => null)) !== null;
}

export async function readWithoutFollowingSymlinks(path: string): Promise<string> {
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

export function findKeyLine(lines: readonly string[], key: string): number | null {
  const prefix = `${key}=`;
  const exportPrefix = `export ${key}=`;
  for (const [index, line] of lines.entries()) {
    const stripped = line.replace(/^\s+/, '');
    if (stripped.startsWith(prefix) || stripped.startsWith(exportPrefix)) return index;
  }
  return null;
}

/** Serialize a value so it round-trips and cannot inject further variables. */
export function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/**
 * Write via a 0600 temp file in the same directory, then rename.
 *
 * SEC-010: this is the one place Lockbox creates a temporary copy of credential
 * material. It is unavoidable for atomicity (SPEC.md §33). The file is created
 * with mode 0600 before any bytes are written, is never world-readable, and is
 * deleted deterministically on any failure path.
 */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = parse(path).dir;
  const temporary = join(directory, `.lockbox-${process.pid}-${Date.now().toString(36)}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();

  try {
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await fs.chmod(path, 0o600).catch(() => undefined);

  const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY).catch(() => null);
  if (directoryHandle) {
    await directoryHandle.sync().catch(() => undefined);
    await directoryHandle.close();
  }
}

/**
 * Set one variable in a .env file, keeping every other line as it was.
 *
 * The value is quoted so it round-trips and cannot start a second variable;
 * the whole file is rewritten atomically.
 */
export async function setEnvVariable(path: string, key: string, value: string): Promise<void> {
  const exists = await fileExists(path);
  const lines = exists ? (await readWithoutFollowingSymlinks(path)).split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const index = findKeyLine(lines, key);
  const line = `${key}=${quote(value)}`;
  const next =
    index === null ? [...lines, line] : [...lines.slice(0, index), line, ...lines.slice(index + 1)];
  await atomicWrite(path, `${next.join('\n')}\n`);
}

/**
 * Resolve a local destination path inside the operator's allowed roots.
 *
 * Refuses traversal, escapes through linked directories and, when asked, any
 * name but `.env` / `.env.<suffix>`.
 */
export function resolveAllowedPath(
  config: LockboxConfig,
  rawPath: string,
  options: { envNamesOnly: boolean },
): string {
  if (rawPath.includes('\0')) {
    throw adapterError(ErrorCode.INVALID_TARGET, 'The destination path is not valid.');
  }
  if (rawPath.split(/[\\/]/).includes('..')) {
    throw adapterError(
      ErrorCode.INVALID_TARGET,
      'Relative path traversal is not permitted in a destination path.',
    );
  }
  const roots = config.envAllowedRoots;
  if (roots.length === 0) {
    throw adapterError(
      ErrorCode.DESTINATION_NOT_PERMITTED,
      'No local destination directory is permitted by policy.',
    );
  }

  const firstRoot = roots[0] as string;
  const candidate = isAbsolute(rawPath) ? rawPath : join(firstRoot, rawPath);
  const parsed = parse(candidate);
  if (!parsed.base || parsed.base === '.' || parsed.base === '..') {
    throw adapterError(ErrorCode.INVALID_TARGET, 'The destination path is not a file.');
  }
  // Anything else under a root (`public/robots.txt`, a build artefact) may be
  // served, bundled or committed.
  if (options.envNamesOnly && !ENV_FILENAME_PATTERN.test(parsed.base)) {
    throw adapterError(
      ErrorCode.DESTINATION_NOT_PERMITTED,
      'Only files named .env or .env.<suffix> may receive a credential.',
    );
  }

  // Canonicalise the *parent*, following symlinks, so a linked directory
  // cannot point outside a root. `path.resolve` alone is purely lexical and
  // would happily accept `root/link-to-elsewhere/.env`. The final component
  // is deliberately left unresolved: it is checked separately, and the write
  // uses rename, which replaces a link rather than following it.
  const parent = canonicalDirectory(parsed.dir);
  if (!roots.some((root) => isWithin(parent, root))) {
    throw adapterError(
      ErrorCode.DESTINATION_NOT_PERMITTED,
      'The destination path is outside the directories permitted by policy.',
    );
  }
  return join(parent, parsed.base);
}

/**
 * Re-check containment immediately before writing.
 *
 * Canonicalising at authorization time cannot bind the filesystem: a parent
 * directory can still be swapped for a symlink afterwards. Repeating the
 * check here shrinks that window to the moment of the write.
 */
export function assertStillInsideRoots(config: LockboxConfig, path: string): void {
  const parent = canonicalDirectory(parse(path).dir);
  if (!config.envAllowedRoots.some((root) => isWithin(parent, root))) {
    throw adapterError(
      ErrorCode.DESTINATION_NOT_PERMITTED,
      'The destination path is outside the directories permitted by policy.',
    );
  }
}

/** A local destination must be a regular file (or absent) in an existing directory. */
export async function validateLocalPath(path: string): Promise<ValidationResult> {
  const stats = await fs.lstat(path).catch(() => null);
  if (stats?.isSymbolicLink()) {
    return {
      ok: false,
      code: ErrorCode.DESTINATION_NOT_PERMITTED,
      message: 'The destination path is a symbolic link and will not be written through.',
    };
  }
  if (stats && !stats.isFile()) {
    return {
      ok: false,
      code: ErrorCode.INVALID_TARGET,
      message: 'The destination path is not a regular file.',
    };
  }
  const parentStats = await fs.stat(parse(path).dir).catch(() => null);
  if (!parentStats?.isDirectory()) {
    return {
      ok: false,
      code: ErrorCode.INVALID_TARGET,
      message: 'The destination directory does not exist.',
    };
  }
  return { ok: true };
}

/**
 * Git hygiene for a local credential file: a tracked file is refused, and so is
 * a new file git would not ignore, which is one `git add .` away from a commit.
 */
export async function gitHygiene(
  config: LockboxConfig,
  path: string,
): Promise<
  { ok: true; exists: boolean; notes: string[] } | { ok: false; code: string; message: string }
> {
  if ((await gitTracks(path)) && !config.allowGitTrackedEnv) {
    return {
      ok: false,
      code: ErrorCode.DESTINATION_NOT_PERMITTED,
      message: 'This file is tracked by git; writing a credential into it is blocked.',
    };
  }
  const exists = await fileExists(path);
  const ignore = await gitIgnoreStatus(path);
  if (!exists && ignore === 'not-ignored' && !config.allowGitTrackedEnv) {
    return {
      ok: false,
      code: ErrorCode.DESTINATION_NOT_PERMITTED,
      message: 'This new file is not git-ignored. Add it to .gitignore first.',
    };
  }
  const notes =
    exists && ignore === 'not-ignored' ? ['This file does not appear to be git-ignored.'] : [];
  return { ok: true, exists, notes };
}

/** The allowed root that contains `path`, if any. */
export function containingRoot(config: LockboxConfig, path: string): string | undefined {
  return config.envAllowedRoots.find((root) => isWithin(parse(path).dir, root));
}

async function git(path: string, args: readonly string[]): Promise<number | null> {
  const directory = parse(path).dir;
  try {
    await execFileAsync('git', ['-C', directory, ...args, '--', path], {
      timeout: GIT_TIMEOUT_MS,
      // No shell: the credential is not here, and neither is a shell string.
      shell: false,
    });
    return 0;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    return typeof code === 'number' ? code : null;
  }
}

async function gitTracks(path: string): Promise<boolean> {
  return (await git(path, ['ls-files', '--error-unmatch'])) === 0;
}

/** `git check-ignore` exits 0 when ignored, 1 when not, and 128 outside a repository. */
async function gitIgnoreStatus(path: string): Promise<'ignored' | 'not-ignored' | 'no-repo'> {
  const code = await git(path, ['check-ignore', '-q']);
  if (code === 0) return 'ignored';
  return code === 1 ? 'not-ignored' : 'no-repo';
}

export const __testing = { isWithin, findKeyLine, quote, sep };

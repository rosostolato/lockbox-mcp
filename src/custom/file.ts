/**
 * The `file` executor (docs/specs/custom-destinations, REQ-008).
 *
 * Every write is still inside an allowed root at the moment it happens, never
 * through a symlink, atomic and `0600`. `create` refuses to overwrite,
 * `replace` writes the whole approved content, and `env` sets one variable in
 * a .env file while keeping every other line.
 */

import { promises as fs } from 'node:fs';

import { adapterError } from '../adapters/base.js';
import type { LockboxConfig } from '../config.js';
import { ErrorCode } from '../errors.js';
import type { StoreResult } from '../model.js';
import type { SecretBuffer } from '../secretBuffer.js';
import { fillText, NAME_PLACEHOLDER, type FileDefinition } from './definition.js';
import {
  assertStillInsideRoots,
  atomicWrite,
  ENV_KEY_PATTERN,
  setEnvVariable,
} from './localFile.js';

/** The variable an `env` definition sets: the text before `=`, with `{{name}}` filled. */
export function envKey(definition: FileDefinition, name: string): string {
  const key = definition.template
    .slice(0, definition.template.indexOf('='))
    .split(NAME_PLACEHOLDER)
    .join(name);
  if (!ENV_KEY_PATTERN.test(key)) {
    throw adapterError(
      ErrorCode.INVALID_TARGET,
      'The credential name is not a valid variable name.',
    );
  }
  return key;
}

export async function writeFile(
  definition: FileDefinition,
  location: { path: string; relative: string },
  secret: SecretBuffer,
  name: string,
  config: LockboxConfig,
): Promise<StoreResult> {
  assertStillInsideRoots(config, location.path);

  const stats = await fs.lstat(location.path).catch(() => null);
  if (stats?.isSymbolicLink()) {
    throw adapterError(
      ErrorCode.DESTINATION_NOT_PERMITTED,
      'The destination path is a symbolic link and will not be written through.',
    );
  }

  if (definition.mode === 'env') {
    const key = envKey(definition, name);
    await setEnvVariable(location.path, key, secret.toText());
    return { stored: true, destinationRef: `${location.relative}:${key}` };
  }
  if (stats && definition.mode === 'create') {
    throw adapterError(
      ErrorCode.DESTINATION_CONFLICT,
      'The file already exists, and this destination only creates it.',
    );
  }
  await atomicWrite(location.path, fillText(definition.template, secret.toText(), name));
  return { stored: true, destinationRef: location.relative };
}

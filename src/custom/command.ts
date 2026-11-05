/**
 * The `command` executor (docs/specs/custom-destinations, REQ-006, REQ-007, NFR-003).
 *
 * Runs the approved program — re-checked against the hash taken at approval —
 * with the approved arguments, no shell, a minimal environment and a timeout,
 * and hands it the credential on standard input only, so it never appears in
 * an argv that `ps` or a crash report could show. Output is read and dropped;
 * the agent learns only whether the program exited 0.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

import { adapterError } from '../adapters/base.js';
import { ErrorCode } from '../errors.js';
import type { StoreResult } from '../model.js';
import { wipe, type SecretBuffer } from '../secretBuffer.js';
import { NAME_PLACEHOLDER, SECRET_PLACEHOLDER, type CommandDefinition } from './definition.js';

export const MAX_OUTPUT_BYTES = 64 * 1024;

export interface PinnedProgram {
  readonly realpath: string;
  readonly sha256: string;
  readonly cwd: string;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolvePromise(hash.digest('hex'));
      });
  });
}

/** The child gets these and nothing else from Lockbox's environment. */
function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

/** stdin as bytes: the template around the credential, the credential copied in, never a string. */
function standardInput(template: string, secret: SecretBuffer, name: string): Buffer {
  const [before = '', after = ''] = template
    .split(SECRET_PLACEHOLDER)
    .map((part) => part.split(NAME_PLACEHOLDER).join(name));
  return Buffer.concat([Buffer.from(before, 'utf8'), secret.view(), Buffer.from(after, 'utf8')]);
}

export async function runCommand(
  definition: CommandDefinition,
  program: PinnedProgram,
  secret: SecretBuffer,
  name: string,
  timeoutMs: number,
): Promise<StoreResult> {
  const current = await sha256File(program.realpath).catch(() => null);
  if (current !== program.sha256) {
    throw adapterError(
      ErrorCode.DESTINATION_NOT_PERMITTED,
      'The program changed after you approved it, so it was not run.',
    );
  }

  const input = standardInput(definition.stdin, secret, name);
  try {
    const code = await new Promise<number | null>((resolvePromise, reject) => {
      const args = definition.args.map((arg) => arg.split(NAME_PLACEHOLDER).join(name));
      const child = spawn(program.realpath, args, {
        cwd: program.cwd,
        env: minimalEnvironment(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      // Output is drained so the child never blocks on a full pipe, and dropped.
      let seen = 0;
      const drain = (chunk: Buffer): void => {
        seen += chunk.byteLength;
        wipe(chunk);
        if (seen > MAX_OUTPUT_BYTES * 16) child.kill('SIGKILL');
      };
      child.stdout.on('data', drain);
      child.stderr.on('data', drain);
      // A program that exits without reading stdin is its own failure, not Lockbox's.
      child.stdin.on('error', () => undefined);

      child.on('error', () => {
        clearTimeout(timer);
        reject(
          adapterError(ErrorCode.DESTINATION_UNAVAILABLE, 'The program could not be started.'),
        );
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            adapterError(ErrorCode.DESTINATION_TIMEOUT, 'The program did not finish in time.'),
          );
          return;
        }
        resolvePromise(exitCode);
      });
      child.stdin.end(input);
    });

    if (code !== 0) {
      throw adapterError(
        ErrorCode.DESTINATION_WRITE_FAILED,
        `The program exited with status ${code ?? 'unknown'}.`,
      );
    }
    return { stored: true, destinationRef: `${basename(program.realpath)} exited 0` };
  } finally {
    wipe(input);
  }
}

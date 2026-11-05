/** docs/specs/custom-destinations — TASK-012 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdapterError } from '../../src/adapters/base.js';
import { runCommand, sha256File } from '../../src/custom/command.js';
import { parseDefinition, type CommandDefinition } from '../../src/custom/definition.js';
import { SecretBuffer } from '../../src/secretBuffer.js';
import { makeTempDir, removeTempDir } from '../support/tmp.js';

describe('command executor', () => {
  let dir: string;
  let script: string;

  const write = (body: string): void => {
    writeFileSync(script, `#!/bin/sh\n${body}\n`);
    chmodSync(script, 0o755);
  };

  beforeEach(() => {
    dir = makeTempDir();
    script = join(dir, 'store-secret');
    write('cat > stdin.txt\nprintf "%s\\n" "$@" > args.txt\nenv > env.txt');
    process.env.LOCKBOX_TEST_PARENT_ONLY = 'must-not-leak';
  });

  afterEach(() => {
    delete process.env.LOCKBOX_TEST_PARENT_ONLY;
    removeTempDir(dir);
  });

  const definition = (overrides: Record<string, unknown> = {}): CommandDefinition =>
    parseDefinition({
      kind: 'command',
      label: 'Helper',
      executable: script,
      args: ['--name', '{{name}}', 'two words'],
      stdin: 'key={{secret}}\n',
      ...overrides,
    }).definition as CommandDefinition;

  const run = async (
    def: CommandDefinition,
    options: { sha256?: string; timeoutMs?: number } = {},
  ): ReturnType<typeof runCommand> =>
    runCommand(
      def,
      { realpath: script, sha256: options.sha256 ?? (await sha256File(script)), cwd: dir },
      new SecretBuffer(Buffer.from('s3cret value', 'utf8')),
      'STRIPE_SECRET_KEY',
      options.timeoutMs ?? 5000,
    );

  const code = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      return (error as AdapterError).public.code;
    }
    return 'resolved';
  };

  it('hands the credential on stdin only, with the approved arguments (REQ-006)', async () => {
    const result = await run(definition());

    expect(result).toEqual({ stored: true, destinationRef: 'store-secret exited 0' });
    expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toBe('key=s3cret value\n');
    expect(readFileSync(join(dir, 'args.txt'), 'utf8')).toBe(
      '--name\nSTRIPE_SECRET_KEY\ntwo words\n',
    );
    expect(readFileSync(join(dir, 'args.txt'), 'utf8')).not.toContain('s3cret');
  });

  it('runs with a minimal environment (REQ-007)', async () => {
    await run(definition());
    const env = readFileSync(join(dir, 'env.txt'), 'utf8');
    expect(env).toContain('PATH=');
    expect(env).not.toContain('LOCKBOX_TEST_PARENT_ONLY');
  });

  it('refuses to run a program that changed after approval', async () => {
    const approved = await sha256File(script);
    write('cat > stdin.txt\necho swapped');
    expect(await code(run(definition(), { sha256: approved }))).toBe('DESTINATION_NOT_PERMITTED');
    expect(existsSync(join(dir, 'stdin.txt'))).toBe(false);
  });

  it('reports a non-zero exit as a failed write', async () => {
    write('cat >/dev/null\nexit 3');
    expect(await code(run(definition()))).toBe('DESTINATION_WRITE_FAILED');
  });

  it('kills a program that does not finish in time', async () => {
    write('sleep 5');
    expect(await code(run(definition(), { timeoutMs: 300 }))).toBe('DESTINATION_TIMEOUT');
  });

  it('tolerates a program that exits without reading stdin', async () => {
    write('exit 0');
    expect((await run(definition())).stored).toBe(true);
  });
});

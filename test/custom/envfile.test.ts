/**
 * `.env` files as custom `file` destinations in `env` mode (REQ-008, REQ-020).
 *
 * Ported from the retired env-file adapter's suite: the same protections,
 * now reached through an agent-written definition.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomDestinationAdapter } from '../../src/adapters/custom.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import { ErrorCode } from '../../src/errors.js';
import { Environment } from '../../src/model.js';
import { SecretBuffer } from '../../src/secretBuffer.js';
import { Canary } from '../support/canary.js';
import { Harness, testConfig } from '../support/harness.js';
import { git, makeTempDir, removeTempDir } from '../support/tmp.js';

function definition(path = '.env', template = '{{name}}={{secret}}'): Record<string, unknown> {
  return { kind: 'file', label: 'Project .env', path, template, mode: 'env' };
}

function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    destination: 'custom',
    name: 'API_TOKEN',
    target: { definition: definition() },
    environment: 'development',
    ...overrides,
  };
}

describe('.env destinations', () => {
  let root: string;
  let harness: Harness;
  let canary: Canary;

  beforeEach(async () => {
    root = makeTempDir();
    const config = testConfig({ envAllowedRoots: [root] });
    harness = await Harness.start(
      config,
      new AdapterRegistry([new CustomDestinationAdapter(config)]),
    );
    canary = Canary.create();
  });

  afterEach(async () => {
    await harness.stop();
    removeTempDir(root);
  });

  it('writes atomically with restrictive permissions and preserves other variables', async () => {
    const envPath = join(root, '.env');
    writeFileSync(envPath, 'EXISTING=keep-me\n# a comment\nOTHER=1\n');

    const payload = await harness.callTool('secret_store', args());
    const status = await harness.finishFlow(payload, canary.value);
    expect(status.state).toBe('STORED');

    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('EXISTING=keep-me');
    expect(content).toContain('# a comment');
    expect(content).toContain(`API_TOKEN="${canary.value}"`);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(['.env']);
  });

  it('quotes the value so it cannot inject further variables', async () => {
    const payload = await harness.callTool('secret_store', args());
    const hostile = 'v"\nEXTRA=injected\n$(whoami)`id`';
    await harness.finishFlow(payload, hostile);

    const content = readFileSync(join(root, '.env'), 'utf8');
    expect(content).not.toContain('\nEXTRA=injected');
    expect(content.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
    expect(content).toContain('\\$');
    expect(content).toContain('\\`');
  });

  it('blocks a git-tracked env file', async () => {
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 't@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, '.env'), 'PLACEHOLDER=1\n');
    git(root, 'add', '.env');
    git(root, 'commit', '-q', '-m', 'add env');

    const payload = await harness.callTool('secret_store', args());
    expect(payload.status).toBe('failed');
    expect(payload.code).toBe(ErrorCode.DESTINATION_NOT_PERMITTED);
  });

  it('allows a gitignored env file', async () => {
    git(root, 'init', '-q');
    writeFileSync(join(root, '.gitignore'), '.env\n');

    const payload = await harness.callTool('secret_store', args());
    const status = await harness.finishFlow(payload, canary.value);
    expect(status.state).toBe('STORED');
  });

  it('refuses a symlinked destination', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const target = join(outside, 'outside.env');
    writeFileSync(target, 'SHOULD_NOT_BE_TOUCHED=1\n');
    symlinkSync(target, join(root, '.env'));

    const payload = await harness.callTool('secret_store', args());
    expect(payload.status).toBe('failed');
    expect(payload.code).toBe(ErrorCode.DESTINATION_NOT_PERMITTED);
    expect(readFileSync(target, 'utf8')).toBe('SHOULD_NOT_BE_TOUCHED=1\n');
  });

  it('does not write through a symlink planted after authorization', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const target = join(outside, 'late.env');
    writeFileSync(target, 'UNTOUCHED=1\n');

    const payload = await harness.callTool('secret_store', args());
    symlinkSync(target, join(root, '.env')); // planted between approval and write

    const status = await harness.finishFlow(payload, canary.value);
    expect(readFileSync(target, 'utf8')).toBe('UNTOUCHED=1\n');
    expect(['STORED', 'FAILED']).toContain(status.state);
  });

  it('replaces an existing variable and says so on the main screen', async () => {
    writeFileSync(join(root, '.env'), 'API_TOKEN=old-value\nKEEP=1\n');

    const payload = await harness.callTool('secret_store', args());
    const page = (await harness.get(harness.pathFor(payload))).body;
    expect(page).toContain('A value already exists here and will be replaced');

    const status = await harness.finishFlow(payload, canary.value);
    expect(status.state).toBe('STORED');
    const content = readFileSync(join(root, '.env'), 'utf8');
    expect(content).not.toContain('old-value');
    expect(content).toContain('KEEP=1');
  });

  it('confirms by path and variable name, not the directory path', async () => {
    const payload = await harness.callTool('secret_store', args());
    await harness.submitSecret(payload, canary.value);
    const page = await harness.get(harness.pathFor(payload));

    expect(page.body).toContain('data-expect=".env:API_TOKEN"');
    expect(page.body).toContain('Save to .env</button>');
    expect(page.body).not.toContain(`data-expect="${root}`);
  });

  it('accepts only env file names by default', async () => {
    for (const path of ['public/robots.txt', 'config.json', 'secrets', '.envrc']) {
      const payload = await harness.callTool(
        'secret_store',
        args({ target: { definition: definition(path) } }),
      );
      expect(payload.status, path).toBe('failed');
      expect(payload.code, path).toBe('DESTINATION_NOT_PERMITTED');
    }
    for (const path of ['.env', '.env.local', '.env.production']) {
      const payload = await harness.callTool(
        'secret_store',
        args({ target: { definition: definition(path) } }),
      );
      expect(payload.status, path).not.toBe('failed');
    }
  });

  it('refuses a new env file that git would not ignore', async () => {
    git(root, 'init', '-q');
    const refused = await harness.callTool('secret_store', args());
    expect(refused.status).toBe('failed');
    expect(String(refused.message)).toContain('.gitignore');

    writeFileSync(join(root, '.gitignore'), '.env\n');
    const allowed = await harness.callTool('secret_store', args());
    expect(allowed.status).not.toBe('failed');
  });

  it('leaves the original intact when the write is interrupted', async () => {
    const envPath = join(root, '.env');
    writeFileSync(envPath, 'EXISTING=keep-me\n');
    const adapter = new CustomDestinationAdapter(testConfig({ envAllowedRoots: [root] }));
    const target = await adapter.normalizeTarget(
      { definition: definition() },
      { name: 'API_TOKEN', environmentHint: Environment.DEVELOPMENT },
    );

    const fsPromises = await import('node:fs/promises');
    const spy = vi.spyOn(fsPromises.default, 'rename').mockRejectedValue(new Error('interrupted'));
    try {
      const buffer = new SecretBuffer(canary.raw);
      await expect(adapter.store(buffer, target)).rejects.toThrow('interrupted');
      buffer.zeroize();
    } finally {
      spy.mockRestore();
    }

    expect(readFileSync(envPath, 'utf8')).toBe('EXISTING=keep-me\n');
    expect(readdirSync(root)).toEqual(['.env']);
  });

  it('refuses paths outside the allowed roots', async () => {
    const payload = await harness.callTool(
      'secret_store',
      args({ target: { definition: definition('/tmp/lockbox-escape.env') } }),
    );
    expect(payload.status).toBe('failed');
    expect(payload.code).toBe(ErrorCode.DESTINATION_NOT_PERMITTED);
    expect(existsSync('/tmp/lockbox-escape.env')).toBe(false);
  });

  it('refuses invalid variable names, literal or from the credential name', async () => {
    for (const key of ['1BAD', 'with-dash', 'with space', 'x'.repeat(200)]) {
      const payload = await harness.callTool(
        'secret_store',
        args({ target: { definition: definition('.env', `${key}={{secret}}`) } }),
      );
      expect(payload.status, key).toBe('failed');
      expect(payload.code, key).toBe(ErrorCode.INVALID_TARGET);
    }
    const badName = await harness.callTool('secret_store', args({ name: 'not-a-variable' }));
    expect(badName.code).toBe(ErrorCode.INVALID_TARGET);

    const payload = await harness.callTool('secret_store', args());
    const fields = (payload.destination as { fields: Record<string, string> }).fields;
    expect(fields.key).toBe('API_TOKEN');
  });

  it('keeps the credential out of every spawned argv', async () => {
    git(root, 'init', '-q');
    writeFileSync(join(root, '.gitignore'), '.env\n');
    const spawned: string[][] = [];
    const childProcess = await import('node:child_process');
    const original = childProcess.default.execFile;
    const spy = vi.spyOn(childProcess.default, 'execFile').mockImplementation(((
      command: string,
      argv: string[],
      ...rest: unknown[]
    ) => {
      spawned.push([command, ...argv]);
      return (original as unknown as (...a: unknown[]) => unknown)(command, argv, ...rest);
    }) as never);

    try {
      const payload = await harness.callTool('secret_store', args());
      await harness.finishFlow(payload, canary.value);
    } finally {
      spy.mockRestore();
    }

    const flattened = spawned.map((argv) => argv.join(' ')).join(' ');
    expect(canary.hitsIn(flattened)).toEqual([]);
    expect(spawned.every((argv) => argv[0] === 'git')).toBe(true);
    chmodSync(join(root, '.env'), 0o600);
  });
});

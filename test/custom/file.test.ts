/** docs/specs/custom-destinations — TASK-013, and the three kinds end to end */

import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CustomDestinationAdapter } from '../../src/adapters/custom.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import { Canary } from '../support/canary.js';
import { Harness, storeArgs, testConfig } from '../support/harness.js';
import { git, makeTempDir, removeTempDir } from '../support/tmp.js';

describe('custom destinations end to end', () => {
  let root: string;
  let harness: Harness;
  let canary: Canary;

  beforeEach(async () => {
    root = makeTempDir();
    // Any file name: these tests cover the `file` kind itself; the .env-only
    // default is covered in envfile.test.ts.
    const config = testConfig({ envAllowedRoots: [root], envAllowAnyFilename: true });
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

  const store = (definition: Record<string, unknown>): Promise<Record<string, unknown>> =>
    harness.callTool('secret_store', storeArgs({ destination: 'custom', target: { definition } }));

  const file = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'file',
    label: 'Local config',
    path: 'config/secrets.yaml',
    template: 'stripe:\n  name: {{name}}\n  key: "{{secret}}"\n',
    mode: 'create',
    ...overrides,
  });

  it('writes a file through the whole flow, 0600, with Stage B (REQ-008)', async () => {
    mkdirSync(join(root, 'config'));
    const status = await harness.finishFlow(await store(file()), canary.value);

    expect(status.state).toBe('STORED');
    const path = join(root, 'config', 'secrets.yaml');
    expect(readFileSync(path, 'utf8')).toBe(
      `stripe:\n  name: STRIPE_SECRET_KEY\n  key: "${canary.value}"\n`,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    harness.collectLogs();
    harness.scanner.assertClean(canary);
  });

  it('refuses to create over an existing file, and replaces with mode replace', async () => {
    writeFileSync(join(root, 'app.env'), 'old\n');
    const refused = await store(file({ path: 'app.env' }));
    expect(refused.code).toBe('DESTINATION_CONFLICT');

    const status = await harness.finishFlow(
      await store(file({ path: 'app.env', mode: 'replace', template: '{{secret}}' })),
      canary.value,
    );
    expect(status.state).toBe('STORED');
    expect(readFileSync(join(root, 'app.env'), 'utf8')).toBe(canary.value);
  });

  it('refuses a symlinked path and a new file git would not ignore', async () => {
    writeFileSync(join(root, 'real.txt'), '');
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    expect((await store(file({ path: 'link.txt' }))).code).toBe('DESTINATION_NOT_PERMITTED');

    git(root, 'init', '-q');
    const unignored = await store(file({ path: 'fresh.yaml' }));
    expect(unignored.code).toBe('DESTINATION_NOT_PERMITTED');
    expect(String(unignored.message)).toContain('.gitignore');
  });

  it('runs a command through the whole flow and keeps the value out of argv', async () => {
    const script = join(root, 'helper');
    writeFileSync(script, '#!/bin/sh\ncat > received.txt\n');
    chmodSync(script, 0o755);

    const status = await harness.finishFlow(
      await store({
        kind: 'command',
        label: 'Helper',
        executable: script,
        args: ['--name', '{{name}}'],
        stdin: '{{secret}}',
      }),
      canary.value,
    );

    expect(status.state).toBe('STORED');
    expect(readFileSync(join(root, 'received.txt'), 'utf8')).toBe(canary.value);
    harness.collectLogs();
    harness.scanner.assertClean(canary);
  });
});

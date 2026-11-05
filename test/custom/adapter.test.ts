/** docs/specs/custom-destinations — TASK-004, TASK-005, TASK-006 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CustomDestinationAdapter } from '../../src/adapters/custom.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import type { LockboxConfig } from '../../src/config.js';
import { parseDefinition } from '../../src/custom/definition.js';
import { CUSTOM_DEFINITION_EXAMPLES } from '../../src/custom/examples.js';
import { DestinationClass } from '../../src/model.js';
import { RecordingAdapter } from '../support/fakes.js';
import { Harness, storeArgs, testConfig } from '../support/harness.js';
import { makeTempDir, removeTempDir } from '../support/tmp.js';

const httpDefinition = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'http',
  label: 'Internal secrets API',
  url: 'https://secrets.example.com/v1/projects/acme/secrets',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: { type: 'json', value: { name: '{{name}}', value: '{{secret}}', data: { tags: ['a'] } } },
  ...overrides,
});

const custom = (definition: Record<string, unknown>): Record<string, unknown> =>
  storeArgs({ destination: 'custom', target: { definition } });

describe('custom destination adapter', () => {
  let root: string;
  let harness: Harness;

  const start = async (overrides: Partial<LockboxConfig> = {}): Promise<void> => {
    const config = testConfig({ envAllowedRoots: [root], envAllowAnyFilename: true, ...overrides });
    harness = await Harness.start(
      config,
      new AdapterRegistry([new RecordingAdapter(config), new CustomDestinationAdapter(config)]),
    );
  };

  beforeEach(async () => {
    root = makeTempDir();
    await start();
  });

  afterEach(async () => {
    await harness.stop();
    removeTempDir(root);
  });

  it('turns an http definition into a high-risk request that needs Stage B (REQ-001, REQ-012)', async () => {
    const payload = await harness.callTool('secret_store', custom(httpDefinition()));

    expect(payload.state).toBe('AWAITING_SECRET_AUTHORIZATION');
    expect((payload.risk as { level: string }).level).toBe('high');
    expect(payload.requires_confirmation).toBe(true);
    const destination = payload.destination as Record<string, unknown>;
    expect(destination.destination_class).toBe(DestinationClass.ARBITRARY_NETWORK);
    expect(destination.account).toBe('secrets.example.com');
    const fields = destination.fields as Record<string, string>;
    expect(fields.definition_hash).toBe(parseDefinition(httpDefinition()).hash);

    const page = await harness.get(harness.pathFor(payload));
    expect(page.body).toContain('secrets.example.com');
  });

  it('screens values, not key names, inside a definition', async () => {
    // `value` and `data` are ordinary keys of an API body.
    expect((await harness.callTool('secret_store', custom(httpDefinition()))).status).not.toBe(
      'failed',
    );

    const smuggled = await harness.callTool(
      'secret_store',
      custom(httpDefinition({ headers: { 'X-Key': 'sk_live_abcdefghijklmnopqrstu' } })),
    );
    expect(smuggled.status).toBe('failed');
    expect(smuggled.code).toBe('FORBIDDEN_FIELD');
  });

  it('pins the executable by real path and content hash (TASK-005)', async () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const script = join(bin, 'store-secret');
    writeFileSync(script, '#!/bin/sh\ncat >/dev/null\n');
    chmodSync(script, 0o755);
    symlinkSync(script, join(bin, 'alias'));

    const payload = await harness.callTool(
      'secret_store',
      custom({
        kind: 'command',
        label: 'Local helper',
        executable: join(bin, 'alias'),
        args: ['--project', 'acme'],
        stdin: '{{secret}}',
      }),
    );
    const destination = payload.destination as Record<string, unknown>;
    const fields = destination.fields as Record<string, string>;
    expect(destination.destination_class).toBe(DestinationClass.LOCAL_COMMAND);
    expect(fields.executable_realpath).toMatch(/store-secret$/);
    expect(fields.executable_sha256).toBe(
      createHash('sha256').update('#!/bin/sh\ncat >/dev/null\n').digest('hex'),
    );
  });

  it('refuses a missing or non-executable program', async () => {
    const plain = join(root, 'not-executable');
    writeFileSync(plain, 'x');
    chmodSync(plain, 0o644);
    for (const executable of [join(root, 'missing'), plain]) {
      const payload = await harness.callTool(
        'secret_store',
        custom({ kind: 'command', label: 'x', executable, args: [], stdin: '{{secret}}' }),
      );
      expect(payload.status).toBe('failed');
      expect(payload.code).toBe('INVALID_TARGET');
    }
  });

  it('resolves a file inside the allowed roots and refuses one outside', async () => {
    mkdirSync(join(root, 'config'));
    const inside = await harness.callTool(
      'secret_store',
      custom({
        kind: 'file',
        label: 'Local config',
        path: 'config/secrets.yaml',
        template: 'key: "{{secret}}"\n',
        mode: 'create',
      }),
    );
    const fields = (inside.destination as Record<string, unknown>).fields as Record<string, string>;
    expect(fields.relative).toBe(join('config', 'secrets.yaml'));

    const outside = await harness.callTool(
      'secret_store',
      custom({
        kind: 'file',
        label: 'Elsewhere',
        path: '/tmp/lockbox-elsewhere.yaml',
        template: '{{secret}}',
        mode: 'create',
      }),
    );
    expect(outside.code).toBe('DESTINATION_NOT_PERMITTED');
  });

  it('applies the operator allowlists for kinds and hosts (REQ-019)', async () => {
    await harness.stop();
    await start({ customKinds: ['file'], customHttpHosts: [] });
    expect((await harness.callTool('secret_store', custom(httpDefinition()))).code).toBe(
      'DESTINATION_NOT_PERMITTED',
    );

    await harness.stop();
    await start({ customHttpHosts: ['api.vercel.com'] });
    expect((await harness.callTool('secret_store', custom(httpDefinition()))).code).toBe(
      'DESTINATION_NOT_PERMITTED',
    );
  });

  it('routes saved:<name> to the custom adapter and refuses a target with it', async () => {
    const unknown = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'saved:vercel-prod', target: {} }),
    );
    expect(unknown.code).toBe('UNKNOWN_DESTINATION');

    const withTarget = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'saved:vercel-prod', target: { definition: httpDefinition() } }),
    );
    expect(withTarget.code).toBe('INVALID_TARGET');
  });

  it('keeps nested targets away from every other adapter', async () => {
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ target: { project: { nested: 'x' }, secret: 'S' } }),
    );
    expect(payload.code).toBe('INVALID_TARGET');
  });

  it('still refuses an arbitrary-network adapter that is not the custom one', () => {
    const config = testConfig();
    const rogue = Object.assign(new RecordingAdapter(config), {
      destinationClass: DestinationClass.ARBITRARY_NETWORK,
    });
    expect(() => new AdapterRegistry([rogue])).toThrow('arbitrary-network');
  });

  it('documents the contract and examples in secret_destinations (REQ-016, REQ-021)', async () => {
    const listing = await harness.callTool('secret_destinations', {});
    const entry = (listing.destinations as Record<string, unknown>[]).find(
      (item) => item.id === 'custom',
    );
    expect(entry?.kinds).toEqual(['http', 'command', 'file']);
    expect(Object.keys(entry?.examples as object)).toEqual([
      'env_file',
      'google_secret_manager',
      'http_api',
    ]);
    for (const example of Object.values(CUSTOM_DEFINITION_EXAMPLES)) {
      expect(() => parseDefinition(example)).not.toThrow();
    }
  });
});

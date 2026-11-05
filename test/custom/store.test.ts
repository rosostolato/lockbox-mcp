/** docs/specs/custom-destinations — TASK-014, TASK-015, TASK-016 */

import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CustomDestinationAdapter } from '../../src/adapters/custom.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import type { LockboxConfig } from '../../src/config.js';
import { parseDefinition } from '../../src/custom/definition.js';
import { SavedDestinations } from '../../src/custom/store.js';
import { Canary } from '../support/canary.js';
import { Harness, storeArgs, testConfig } from '../support/harness.js';
import { makeTempDir, removeTempDir } from '../support/tmp.js';

const httpDefinition = {
  kind: 'http',
  label: 'Internal secrets API',
  url: 'https://secrets.example.com/v1/secrets',
  method: 'POST',
  headers: { 'X-Team': 'payments' },
  body: { type: 'json', value: { value: '{{secret}}' } },
};

describe('saved destinations store', () => {
  let dir: string;
  let store: SavedDestinations;

  beforeEach(() => {
    dir = makeTempDir();
    store = new SavedDestinations(join(dir, 'lockbox', 'destinations.json'));
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it('saves atomically with mode 0600 and reads entries back intact (NFR-005)', async () => {
    const parsed = parseDefinition(httpDefinition);
    await store.save('internal-api', parsed.canonical, parsed.hash);

    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(store.path)).mode & 0o777).toBe(0o700);
    const entry = await store.get('internal-api');
    expect(entry?.intact).toBe(true);
    expect(entry?.hash).toBe(parsed.hash);
    expect((await store.knownHosts()).has('secrets.example.com')).toBe(true);
  });

  it('reports an edited entry as changed, never as approved (REQ-014)', async () => {
    const parsed = parseDefinition(httpDefinition);
    await store.save('internal-api', parsed.canonical, parsed.hash);
    const file = readFileSync(store.path, 'utf8');
    writeFileSync(store.path, file.replace('secrets.example.com', 'secrets.examp1e.com'));

    expect((await store.get('internal-api'))?.intact).toBe(false);
    expect(await store.byHash(parsed.hash)).toBeUndefined();
    expect((await store.knownHosts()).size).toBe(0);
  });

  it('treats a corrupt store as empty and refuses invalid names', async () => {
    await store.save('x', parseDefinition(httpDefinition).canonical, 'h');
    writeFileSync(store.path, '{not json');
    expect(await store.list()).toEqual([]);
    await expect(store.save('Bad Name', '{}', 'h')).rejects.toThrow();
  });
});

describe('saving from the window', () => {
  let root: string;
  let harness: Harness;
  let canary: Canary;
  let config: LockboxConfig;

  const start = async (overrides: Partial<LockboxConfig> = {}): Promise<void> => {
    config = testConfig({ envAllowedRoots: [root], ...overrides });
    harness = await Harness.start(
      config,
      new AdapterRegistry([new CustomDestinationAdapter(config)]),
    );
  };

  beforeEach(async () => {
    root = makeTempDir();
    canary = Canary.create();
    await start();
  });

  afterEach(async () => {
    await harness.stop();
    removeTempDir(root);
  });

  const helper = (exitCode = 0): Record<string, unknown> => {
    const script = join(root, `helper-${exitCode}`);
    writeFileSync(script, `#!/bin/sh\ncat > received.txt\nexit ${exitCode}\n`);
    chmodSync(script, 0o755);
    return {
      kind: 'command',
      label: 'Local Helper',
      executable: script,
      args: [],
      stdin: '{{secret}}',
    };
  };

  const confirmWith = async (
    payload: Record<string, unknown>,
    extra: Record<string, string>,
  ): Promise<{ status: number; body: string }> => {
    await harness.submitSecret(payload, canary.value);
    const path = harness.pathFor(payload);
    const page = await harness.get(path);
    const token = /name="confirm_token" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
    const phrase = /data-expect="([^"]*)"/.exec(page.body)?.[1] ?? '';
    return harness.post(`${path}/confirm`, {
      confirm_token: token,
      confirm_name: phrase,
      ...extra,
    });
  };

  it('offers saving at Stage B and saves only after a successful write (REQ-013)', async () => {
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'custom', target: { definition: helper() } }),
    );
    await harness.submitSecret(payload, canary.value);
    const stageB = (await harness.get(harness.pathFor(payload))).body;
    expect(stageB).toContain('Save as a trusted destination');
    expect(stageB).toContain('value="local-helper"');

    // Already submitted above; confirm with the box ticked.
    const path = harness.pathFor(payload);
    const token = /name="confirm_token" value="([^"]+)"/.exec(stageB)?.[1] ?? '';
    await harness.post(`${path}/confirm`, {
      confirm_token: token,
      confirm_name: 'helper-0',
      save: '1',
      save_as: 'local-helper',
    });
    expect((await harness.status(payload.request_id as string)).state).toBe('STORED');
    expect((await SavedDestinations.for(config).get('local-helper'))?.intact).toBe(true);
  });

  it('does not save a destination whose write failed', async () => {
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'custom', target: { definition: helper(3) } }),
    );
    await confirmWith(payload, { save: '1', save_as: 'broken' });
    expect((await harness.status(payload.request_id as string)).state).toBe('FAILED');
    expect(await SavedDestinations.for(config).get('broken')).toBeUndefined();
  });

  it('refuses an invalid name before anything runs', async () => {
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'custom', target: { definition: helper() } }),
    );
    const response = await confirmWith(payload, { save: '1', save_as: 'Not Valid!' });
    expect(response.status).toBe(400);
    expect((await harness.status(payload.request_id as string)).state).toBe(
      'AWAITING_EXECUTION_CONFIRMATION',
    );
  });

  it('reuses a saved destination by name, lists it and recognises it (REQ-015, REQ-016)', async () => {
    const definition = helper();
    const parsed = parseDefinition(definition);
    await SavedDestinations.for(config).save('local-helper', parsed.canonical, parsed.hash);

    const bySaved = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'saved:local-helper', target: {} }),
    );
    const page = (await harness.get(harness.pathFor(bySaved))).body;
    expect(page).toContain('Saved <span class="sep">·</span> local-helper');

    await harness.submitSecret(bySaved, canary.value);
    expect((await harness.get(harness.pathFor(bySaved))).body).not.toContain(
      'Save as a trusted destination',
    );

    const resent = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'custom', target: { definition } }),
    );
    expect((await harness.get(harness.pathFor(resent))).body).toContain('local-helper');

    const listing = await harness.callTool('secret_destinations', {});
    const custom = (listing.destinations as Record<string, unknown>[]).find(
      (entry) => entry.id === 'custom',
    );
    expect(custom?.saved).toEqual([
      expect.objectContaining({
        destination: 'saved:local-helper',
        kind: 'command',
        hash_prefix: parsed.hash.slice(0, 12),
      }),
    ]);
    expect(JSON.stringify(custom?.saved)).not.toContain('{{secret}}');
  });

  it('shows "changed since you saved it" for an edited entry (REQ-014)', async () => {
    const parsed = parseDefinition(httpDefinition);
    const store = SavedDestinations.for(config);
    await store.save('internal-api', parsed.canonical, parsed.hash);
    writeFileSync(store.path, readFileSync(store.path, 'utf8').replace('payments', 'attacker'));

    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'saved:internal-api', target: {} }),
    );
    const page = (await harness.get(harness.pathFor(payload))).body;
    expect(page).toContain('Changed since you saved it as internal-api');
    expect(page).not.toContain('Saved <span class="sep">·</span>');
  });

  it('does not flag a host the human already saved as first time', async () => {
    const parsed = parseDefinition(httpDefinition);
    await SavedDestinations.for(config).save('internal-api', parsed.canonical, parsed.hash);
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({
        destination: 'custom',
        target: { definition: { ...httpDefinition, url: 'https://secrets.example.com/v2/other' } },
      }),
    );
    expect((await harness.get(harness.pathFor(payload))).body).not.toContain('First time sending');
  });

  it('forgets a saved destination from the window (REQ-017)', async () => {
    const parsed = parseDefinition(helper());
    await SavedDestinations.for(config).save('local-helper', parsed.canonical, parsed.hash);
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'saved:local-helper', target: {} }),
    );
    const path = harness.pathFor(payload);
    expect((await harness.get(path)).body).toContain('Forget the saved destination');
    await harness.post(`${path}/forget`, {});

    expect(await SavedDestinations.for(config).get('local-helper')).toBeUndefined();
    const again = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'saved:local-helper', target: {} }),
    );
    expect(again.code).toBe('UNKNOWN_DESTINATION');
  });

  it('never saves when the operator chose once (REQ-018)', async () => {
    await harness.stop();
    await start({ customDestinations: 'once' });
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'custom', target: { definition: helper() } }),
    );
    await harness.submitSecret(payload, canary.value);
    expect((await harness.get(harness.pathFor(payload))).body).not.toContain(
      'Save as a trusted destination',
    );
    const path = harness.pathFor(payload);
    const page = (await harness.get(path)).body;
    const token = /name="confirm_token" value="([^"]+)"/.exec(page)?.[1] ?? '';
    await harness.post(`${path}/confirm`, {
      confirm_token: token,
      confirm_name: 'helper-0',
      save: '1',
      save_as: 'sneaky',
    });
    expect((await harness.status(payload.request_id as string)).state).toBe('STORED');
    expect(await SavedDestinations.for(config).get('sneaky')).toBeUndefined();
  });
});

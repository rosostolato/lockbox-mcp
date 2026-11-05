/** docs/specs/custom-destinations — TASK-007, TASK-007b, TASK-008, TASK-009 */

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CustomDestinationAdapter } from '../../src/adapters/custom.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import { destinationLine, exactView, riskSignals } from '../../src/custom/render.js';
import { Environment, type NormalizedTarget } from '../../src/model.js';
import { Canary } from '../support/canary.js';
import { Harness, storeArgs, testConfig } from '../support/harness.js';
import { makeTempDir, removeTempDir } from '../support/tmp.js';

const http = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'http',
  label: 'Internal secrets API',
  url: 'https://secrets.example.com/v1/projects/acme/secrets',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Note': 'a <b>bold</b> header' },
  body: { type: 'json', value: { name: '{{name}}', value: '{{secret}}' } },
  reference: '$.id',
  ...overrides,
});

describe('custom destination rendering', () => {
  let root: string;
  let adapter: CustomDestinationAdapter;

  const normalize = (definition: Record<string, unknown>): Promise<NormalizedTarget> =>
    adapter.normalizeTarget(
      { definition },
      { name: 'STRIPE_SECRET_KEY', environmentHint: Environment.UNKNOWN },
    );

  beforeEach(() => {
    root = makeTempDir();
    adapter = new CustomDestinationAdapter(testConfig({ envAllowedRoots: [root] }));
  });

  afterEach(() => {
    removeTempDir(root);
  });

  it('reduces the destination to one line: label and short target (REQ-009)', async () => {
    const line = destinationLine(await normalize(http()));
    expect(line).toContain('Internal secrets API');
    expect(line).toContain('secrets.example.com');
    expect(line).not.toContain('/v1/projects');
  });

  it('keeps the full operation behind a closed disclosure (REQ-010)', async () => {
    const target = await normalize(http());
    const view = exactView(target, 'STRIPE_SECRET_KEY');

    expect(view.startsWith('<details class="exact"><summary>')).toBe(true);
    expect(view).not.toMatch(/<details[^>]*\sopen/);
    expect(view).toContain(
      '<strong>POST</strong> https://secrets.example.com/v1/projects/acme/secrets',
    );
    expect(view).toContain('Content-Type');
    expect(view).toContain('<span class="chip-secret">•••• STRIPE_SECRET_KEY</span>');
    expect(view).toContain(target.fields.definition_hash);
    expect(view).toContain('$.id');
    // Agent-written text is escaped, never markup.
    expect(view).toContain('a &lt;b&gt;bold&lt;/b&gt; header');
    expect(view).not.toContain('<b>bold</b>');
  });

  it('renders a command as the program, each argument and stdin', async () => {
    const view = exactView(
      await normalize({
        kind: 'command',
        label: 'Shell helper',
        executable: '/bin/sh',
        args: ['-c', 'cat >/dev/null', '--', 'two words', '{{name}}'],
        stdin: '{{secret}}\n',
      }),
      'STRIPE_SECRET_KEY',
    );
    expect(view).toContain('<strong>Runs</strong> /bin/sh');
    expect(view).toContain('<li><code>two words</code></li>');
    expect(view).toContain(
      '<li><code><span class="chip-name">STRIPE_SECRET_KEY</span></code></li>',
    );
    expect(view).toContain('Standard input');
  });

  it('flags first-time, punycode and IP-literal hosts (REQ-011)', async () => {
    expect(riskSignals(await normalize(http()))).toEqual([
      'First time sending to secrets.example.com',
    ]);
    // A host the human approved before is not "first time".
    expect(riskSignals(await normalize(http()), new Set(['secrets.example.com']))).toEqual([]);

    const homograph = riskSignals(await normalize(http({ url: 'https://аpple.com/keys' })));
    expect(homograph).toContain('Host uses non-ASCII characters, shown here as xn--pple-43d.com');

    const ip = riskSignals(await normalize(http({ url: 'https://203.0.113.5/keys' })));
    expect(ip).toContain('Sends to an IP address instead of a host name');
  });

  it('flags a program outside the system folders, and not one inside', async () => {
    const script = join(root, 'helper');
    writeFileSync(script, '#!/bin/sh\n');
    chmodSync(script, 0o755);
    const command = (executable: string): Record<string, unknown> => ({
      kind: 'command',
      label: 'x',
      executable,
      args: [],
      stdin: '{{secret}}',
    });

    expect(riskSignals(await normalize(command(script)))[0]).toMatch(
      /^Runs a program outside the system folders: .*helper$/,
    );
    expect(riskSignals(await normalize(command('/bin/sh')))).toEqual([]);
  });
});

describe('custom destination pages', () => {
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

  it('shows the line and the signals on the main screen, the detail closed', async () => {
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'custom', target: { definition: http() } }),
    );
    const body = (await harness.get(harness.pathFor(payload))).body;

    const field = body.indexOf('<form id="entry"');
    expect(body.indexOf('First time sending to secrets.example.com')).toBeLessThan(field);
    expect(body.indexOf('Internal secrets API')).toBeLessThan(field);
    expect(body.indexOf('<details class="exact">')).toBeGreaterThan(field);
    expect(body).not.toMatch(/<details class="exact"[^>]*\sopen/);
  });

  it('confirms by host at Stage B, with the detail still one click away (TASK-009)', async () => {
    const payload = await harness.callTool(
      'secret_store',
      storeArgs({ destination: 'custom', target: { definition: http() } }),
    );
    await harness.submitSecret(payload, canary.value);
    const body = (await harness.get(harness.pathFor(payload))).body;

    expect(body).toContain('Send to secrets.example.com?');
    expect(body).toContain('data-expect="secrets.example.com"');
    expect(body).toContain('<details class="exact">');
    expect(body).not.toContain(canary.value);
  });
});

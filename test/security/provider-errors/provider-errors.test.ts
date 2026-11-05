/** SPEC.md §20, §32 — no raw provider output crosses the MCP boundary. */

import { describe, expect, it } from 'vitest';

import { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { SecretDestinationAdapter } from '../../../src/adapters/base.js';
import { Canary } from '../../support/canary.js';
import {
  EchoingErrorAdapter,
  EchoingSanitizerAdapter,
  LeakyResultAdapter,
  MalformedResultAdapter,
  RaisingSanitizerAdapter,
  SlowAdapter,
} from '../../support/fakes.js';
import { Harness, testConfig } from '../../support/harness.js';

function args(destination: string): Record<string, unknown> {
  return {
    destination,
    name: 'API_TOKEN',
    target: { project: 'acme-dev-project', secret: 'API_TOKEN' },
    write_mode: 'create',
  };
}

async function withHarness<T>(
  build: (config: ReturnType<typeof testConfig>) => SecretDestinationAdapter,
  run: (harness: Harness, canary: Canary) => Promise<T>,
  overrides: Partial<ReturnType<typeof testConfig>> = {},
): Promise<T> {
  const config = testConfig(overrides);
  const harness = await Harness.start(config, new AdapterRegistry([build(config)]));
  try {
    return await run(harness, Canary.create());
  } finally {
    await harness.stop();
  }
}

describe('provider error sanitization', () => {
  const cases: [
    string,
    (config: ReturnType<typeof testConfig>) => SecretDestinationAdapter,
    string,
  ][] = [
    [
      'echoes the secret in its error',
      (c) => new EchoingErrorAdapter(c),
      'DESTINATION_WRITE_FAILED',
    ],
    ['leaks through its own sanitizer', (c) => new EchoingSanitizerAdapter(c), 'INTERNAL_ERROR'],
    ['throws inside its sanitizer', (c) => new RaisingSanitizerAdapter(c), 'INTERNAL_ERROR'],
    ['returns the secret in its result', (c) => new LeakyResultAdapter(c), 'INTERNAL_ERROR'],
    ['returns an unusable result', (c) => new MalformedResultAdapter(c), 'INTERNAL_ERROR'],
  ];

  for (const [name, build, expectedCode] of cases) {
    it(`sanitizes an adapter that ${name}`, async () => {
      await withHarness(build, async (harness, canary) => {
        const adapterId = harness.registry.ids()[0] ?? '';
        const payload = await harness.callTool('secret_store', args(adapterId));
        const status = await harness.finishFlow(payload, canary.value);

        expect(status.state).toBe('FAILED');
        expect((status.error as { code: string }).code).toBe(expectedCode);
        expect(String((status.error as { message: string }).message)).not.toContain(canary.value);

        harness.collectLogs();
        harness.scanner.assertClean(canary);
      });
    });
  }

  it('reports an adapter timeout without detail', async () => {
    await withHarness(
      (config) => new SlowAdapter(config),
      async (harness, canary) => {
        const payload = await harness.callTool('secret_store', args('slow-store'));
        const status = await harness.finishFlow(payload, canary.value);
        expect(status.state).toBe('FAILED');
        expect((status.error as { code: string }).code).toBe('DESTINATION_TIMEOUT');
      },
      { adapterTimeoutSeconds: 1 },
    );
  });
  // Provider status codes are mapped by the http executor: test/custom/http.test.ts.
});

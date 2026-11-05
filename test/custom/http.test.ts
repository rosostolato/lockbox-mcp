/** docs/specs/custom-destinations — TASK-011 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdapterError } from '../../src/adapters/base.js';
import { parseDefinition, type HttpDefinition } from '../../src/custom/definition.js';
import { isPrivateAddress, sendHttp } from '../../src/custom/http.js';
import { SecretBuffer } from '../../src/secretBuffer.js';
import { makeTempDir, removeTempDir } from '../support/tmp.js';

interface Seen {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('http executor', () => {
  let dir: string;
  let server: Server;
  let ca: string;
  let base: string;
  let seen: Seen[] = [];

  beforeAll(async () => {
    dir = makeTempDir();
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
    server = createServer(
      { key: readFileSync(join(dir, 'key.pem')), cert: ca },
      (request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
        request.on('end', () => {
          const path = request.url ?? '/';
          seen.push({ path, headers: request.headers, body });
          const status = /^\/status\/(\d{3})$/.exec(path);
          if (status) {
            response.writeHead(Number(status[1])).end('{"error":"provider failure"}');
          } else if (path === '/redirect') {
            response.writeHead(302, { location: '/elsewhere' }).end();
          } else if (path === '/denied') {
            response.writeHead(403).end();
          } else if (path === '/echo') {
            const parsed = JSON.parse(body) as { value: string };
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ id: parsed.value }));
          } else if (path === '/hang') {
            // Never answers.
          } else {
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ created: { id: 'ver-4' }, echo: body }));
          }
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `https://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeTempDir(dir);
  });

  beforeEach(() => {
    seen = [];
  });

  const definition = (overrides: Record<string, unknown> = {}): HttpDefinition =>
    parseDefinition({
      kind: 'http',
      label: 'Test API',
      url: `${base}/secrets`,
      method: 'POST',
      headers: {},
      body: { type: 'json', value: { name: '{{name}}', value: '{{secret}}' } },
      reference: '$.created.id',
      ...overrides,
    }).definition as HttpDefinition;

  const send = (
    def: HttpDefinition,
    value: string,
    options: { allowPrivate?: boolean; timeoutMs?: number } = {},
  ): ReturnType<typeof sendHttp> =>
    sendHttp(def, new SecretBuffer(Buffer.from(value, 'utf8')), 'STRIPE_SECRET_KEY', {
      timeoutMs: options.timeoutMs ?? 5000,
      allowPrivate: options.allowPrivate ?? true,
      ca,
    });

  const code = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      return (error as AdapterError).public.code;
    }
    return 'resolved';
  };

  it('sends the approved JSON body with the credential as a JSON string (REQ-005)', async () => {
    const value = 'sk_test "quoted" \\ back\\slash';
    const result = await send(definition(), value);

    expect(result).toEqual({ stored: true, destinationRef: 'ver-4', detail: { status: '201' } });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ name: 'STRIPE_SECRET_KEY', value });
    expect(seen[0]?.headers['content-type']).toBe('application/json');
  });

  it('puts the credential in a header when the definition says so', async () => {
    await send(
      definition({ headers: { Authorization: 'Bearer {{secret}}' }, body: { type: 'none' } }),
      'abc123',
    );
    expect(seen[0]?.headers.authorization).toBe('Bearer abc123');
    expect(seen[0]?.body).toBe('');
  });

  it('refuses a credential with a line break in a header, before connecting', async () => {
    const outcome = await code(
      send(
        definition({ headers: { Authorization: 'Bearer {{secret}}' }, body: { type: 'none' } }),
        'abc\r\nX-Injected: 1',
      ),
    );
    expect(outcome).toBe('INVALID_TARGET');
    expect(seen).toHaveLength(0);
  });

  it('does not follow redirects', async () => {
    expect(await code(send(definition({ url: `${base}/redirect` }), 'v'))).toBe(
      'DESTINATION_WRITE_FAILED',
    );
    expect(seen.map((request) => request.path)).toEqual(['/redirect']);
  });

  it('maps a refusal to DESTINATION_DENIED', async () => {
    expect(await code(send(definition({ url: `${base}/denied` }), 'v'))).toBe('DESTINATION_DENIED');
  });

  for (const [status, expected] of [
    [401, 'DESTINATION_DENIED'],
    [404, 'DESTINATION_NOT_FOUND'],
    [409, 'DESTINATION_CONFLICT'],
    [429, 'DESTINATION_RATE_LIMITED'],
    [500, 'DESTINATION_WRITE_FAILED'],
    [503, 'DESTINATION_UNAVAILABLE'],
  ] as const) {
    it(`maps provider status ${status} to ${expected}`, async () => {
      expect(await code(send(definition({ url: `${base}/status/${status}` }), 'v'))).toBe(expected);
    });
  }

  it('drops a reference that carries the credential back', async () => {
    const result = await send(definition({ url: `${base}/echo`, reference: '$.id' }), 'echo-me');
    expect(result.destinationRef).not.toContain('echo-me');
    expect(result.destinationRef).toMatch(/^localhost:\d+ answered 201$/);
  });

  it('refuses private and local addresses unless the operator allows them', async () => {
    expect(await code(send(definition(), 'v', { allowPrivate: false }))).toBe(
      'DESTINATION_NOT_PERMITTED',
    );
    expect(seen).toHaveLength(0);
  });

  it('gives up after the timeout', async () => {
    expect(await code(send(definition({ url: `${base}/hang` }), 'v', { timeoutMs: 300 }))).toBe(
      'DESTINATION_TIMEOUT',
    );
  });

  it('classifies addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.168.0.9',
      '::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      'fd00::5',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '2001:4860:4860::8888', '172.32.0.1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

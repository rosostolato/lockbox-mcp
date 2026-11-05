/** docs/specs/custom-destinations — TASK-002, TASK-003 */

import { describe, expect, it } from 'vitest';

import { AdapterError } from '../../src/adapters/base.js';
import {
  canonicalize,
  definitionHash,
  parseDefinition,
  type CustomDefinition,
} from '../../src/custom/definition.js';

const http = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'http',
  label: 'Vercel env var',
  url: 'https://api.vercel.com/v10/projects/acme/env',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: { type: 'json', value: { key: '{{name}}', value: '{{secret}}', target: ['production'] } },
  reference: '$.created.id',
  ...overrides,
});

const command = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'command',
  label: 'gcloud secret version',
  executable: '/usr/local/bin/gcloud',
  args: ['secrets', 'versions', 'add', 'stripe-key', '--data-file=-'],
  stdin: '{{secret}}',
  ...overrides,
});

const file = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'file',
  label: 'Local config',
  path: 'config/secrets.yaml',
  template: 'stripe:\n  key: "{{secret}}"\n',
  mode: 'create',
  ...overrides,
});

function refusal(input: unknown): string {
  try {
    parseDefinition(input);
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).public.code).toBe('INVALID_TARGET');
    return (error as AdapterError).public.message;
  }
  throw new Error('expected the definition to be refused');
}

describe('custom destination definitions', () => {
  it('accepts one valid definition of each kind', () => {
    for (const input of [http(), command(), file()]) {
      const parsed = parseDefinition(input);
      expect(parsed.definition.kind).toBe(input.kind);
      expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const headerOnly = http({
      headers: { Authorization: 'Bearer {{secret}}' },
      body: { type: 'none' },
    });
    expect(parseDefinition(headerOnly).definition.kind).toBe('http');
  });

  it('refuses unknown kinds and unknown fields', () => {
    expect(refusal({ ...http(), kind: 'webhook' })).toContain('not valid');
    expect(refusal({ ...http(), extra: 1 })).toContain('not valid');
    expect(refusal({ ...command(), shell: true })).toContain('not valid');
  });

  it('keeps the credential out of the URL, the method list and argv (REQ-004, REQ-006)', () => {
    expect(refusal(http({ url: 'http://api.vercel.com/env' }))).toContain('https');
    expect(refusal(http({ url: 'https://api.example.com/?key={{secret}}' }))).toContain('url');
    expect(refusal(http({ url: 'https://user:pw@api.example.com/' }))).toContain('URL');
    expect(refusal(http({ method: 'GET' }))).toContain('method');
    expect(refusal(command({ args: ['--value', '{{secret}}'], stdin: 'x' }))).toContain('args');
    expect(refusal(command({ executable: 'gcloud' }))).toContain('absolute');
  });

  it('allows only {{secret}} and {{name}} and no shell expansions (REQ-002)', () => {
    for (const stdin of [
      '{{secret}} ${HOME}',
      '{{secret}} $(id)',
      '{{secret}} `id`',
      '{{env.X}}{{secret}}',
      '{{ secret }}',
    ]) {
      expect(refusal(command({ stdin }))).toMatch(/placeholder|expansion/i);
    }
  });

  it('requires the credential exactly once, as a whole JSON leaf', () => {
    expect(refusal(command({ stdin: 'no placeholder' }))).toContain('exactly once (found 0)');
    expect(refusal(file({ template: '{{secret}}\n{{secret}}' }))).toContain('found 2');
    expect(
      refusal(http({ body: { type: 'json', value: { value: 'Bearer {{secret}}' } } })),
    ).toContain('whole string value');
    expect(refusal(http({ headers: { Authorization: 'Bearer {{secret}}' } }))).toContain('found 2');
  });

  it('refuses header injection and oversized shapes (NFR-004)', () => {
    expect(refusal(http({ headers: { 'X-A': 'one\r\nX-B: two' } }))).toContain('line breaks');
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-${i}`, 'v']));
    expect(refusal(http({ headers: many }))).toContain('Too many headers');
    expect(refusal(command({ args: Array.from({ length: 65 }, () => 'a') }))).toContain('args');
  });

  it('refuses a definition that already carries a credential (REQ-003)', () => {
    const message = refusal(
      http({ headers: { Authorization: 'Bearer sk_live_abcdefghijklmnop' } }),
    );
    expect(message).toContain('looks like a credential');
    expect(message).not.toContain('sk_live_');
  });

  it('gives a definition one identity regardless of key order or whitespace (TASK-003)', () => {
    const a = parseDefinition(http());
    const reordered = JSON.parse(JSON.stringify(http())) as Record<string, unknown>;
    const b = parseDefinition(Object.fromEntries(Object.entries(reordered).reverse()));
    expect(b.hash).toBe(a.hash);
    expect(b.canonical).toBe(a.canonical);

    const changed = parseDefinition(http({ url: 'https://api.vercel.com/v10/projects/acme/env2' }));
    expect(changed.hash).not.toBe(a.hash);
  });

  it('canonicalizes as RFC 8785 does', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], c: { z: 0.5, y: 1e21 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":1e+21,"z":0.5}}',
    );
    expect(definitionHash('{}')).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    const parsed: CustomDefinition = parseDefinition(file()).definition;
    expect(JSON.parse(canonicalize(parsed))).toEqual(parsed);
  });
});

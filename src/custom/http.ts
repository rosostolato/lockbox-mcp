/**
 * The `http` executor (docs/specs/custom-destinations, REQ-004, REQ-005, NFR-003).
 *
 * Sends exactly the approved request and nothing else: https only, no
 * redirects followed, the host resolved once and the connection pinned to that
 * address (with normal TLS verification against the host name), private and
 * local addresses refused unless the operator allows them. The agent learns
 * the status and, when the definition asks for one, a short reference read
 * from the response — never the response itself.
 */

import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

import { adapterError } from '../adapters/base.js';
import { ErrorCode } from '../errors.js';
import type { StoreResult } from '../model.js';
import { safeDisplay } from '../redaction.js';
import { wipe, type SecretBuffer } from '../secretBuffer.js';
import { fillJson, fillText, SECRET_PLACEHOLDER, type HttpDefinition } from './definition.js';

export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface HttpOptions {
  readonly timeoutMs: number;
  readonly allowPrivate: boolean;
  /** Extra trusted CA, for tests against a local TLS server only. */
  readonly ca?: string;
}

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

/** Loopback, private, link-local (cloud metadata lives there) or unspecified. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return PRIVATE.check(mapped[1], 'ipv4');
    return PRIVATE.check(address, 'ipv6');
  }
  return family === 4 && PRIVATE.check(address, 'ipv4');
}

export async function sendHttp(
  definition: HttpDefinition,
  secret: SecretBuffer,
  name: string,
  options: HttpOptions,
): Promise<StoreResult> {
  const url = new URL(definition.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');

  const resolved = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  const pinned = resolved[0];
  if (!pinned) {
    throw adapterError(ErrorCode.DESTINATION_UNAVAILABLE, 'The destination host did not resolve.');
  }
  if (!options.allowPrivate && isPrivateAddress(pinned.address)) {
    throw adapterError(
      ErrorCode.DESTINATION_NOT_PERMITTED,
      'The destination resolves to a private or local address (LOCKBOX_CUSTOM_HTTP_ALLOW_PRIVATE).',
    );
  }

  const value = secret.toText();
  const headers: Record<string, string> = {};
  for (const [header, template] of Object.entries(definition.headers)) {
    if (template.includes(SECRET_PLACEHOLDER) && /[\r\n\0]/.test(value)) {
      throw adapterError(
        ErrorCode.INVALID_TARGET,
        'The credential contains a line break, so it cannot be sent in a header.',
      );
    }
    headers[header] = fillText(template, value, name);
  }

  let body: Buffer | null = null;
  const lower = new Set(Object.keys(headers).map((header) => header.toLowerCase()));
  if (definition.body.type === 'json') {
    body = Buffer.from(JSON.stringify(fillJson(definition.body.value, value, name)), 'utf8');
    if (!lower.has('content-type')) headers['Content-Type'] = 'application/json';
  } else if (definition.body.type === 'text') {
    body = Buffer.from(fillText(definition.body.value, value, name), 'utf8');
    if (!lower.has('content-type')) headers['Content-Type'] = definition.body.contentType;
  }
  if (body) headers['Content-Length'] = String(body.byteLength);

  try {
    const response = await exchange(url, definition.method, headers, body, pinned, options);
    return interpret(definition, response, value);
  } finally {
    if (body) wipe(body);
  }
}

interface Response {
  readonly status: number;
  readonly body: Buffer;
}

function exchange(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  pinned: { address: string; family: number },
  options: HttpOptions,
): Promise<Response> {
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest(url, {
      method,
      headers,
      ...(options.ca ? { ca: options.ca } : {}),
      // Connect to the address resolved above; TLS still verifies the host name.
      lookup: ((
        _host: string,
        lookupOptions: { all?: boolean },
        callback: (error: null, address: unknown, family?: number) => void,
      ) => {
        if (lookupOptions.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      }) as never,
    });

    const timer = setTimeout(() => {
      request.destroy(
        adapterError(ErrorCode.DESTINATION_TIMEOUT, 'The destination did not answer in time.'),
      );
    }, options.timeoutMs);

    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else response.destroy();
      });
      response.on('close', () => {
        clearTimeout(timer);
        const data = Buffer.concat(chunks);
        for (const chunk of chunks) wipe(chunk);
        resolvePromise({ status: response.statusCode ?? 0, body: data });
      });
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(
        error instanceof Error && 'public' in error
          ? error
          : adapterError(
              ErrorCode.DESTINATION_UNAVAILABLE,
              'The destination could not be reached.',
            ),
      );
    });
    request.end(body ?? undefined);
  });
}

function interpret(definition: HttpDefinition, response: Response, secret: string): StoreResult {
  const { status } = response;
  try {
    if (status >= 300 && status < 400) {
      throw adapterError(
        ErrorCode.DESTINATION_WRITE_FAILED,
        'The destination answered with a redirect, which Lockbox does not follow.',
      );
    }
    if (status === 401 || status === 403) {
      throw adapterError(ErrorCode.DESTINATION_DENIED, 'The destination refused the request.');
    }
    if (status === 404) {
      throw adapterError(ErrorCode.DESTINATION_NOT_FOUND, 'The destination was not found.');
    }
    if (status === 409) {
      throw adapterError(ErrorCode.DESTINATION_CONFLICT, 'The destination reported a conflict.');
    }
    if (status === 429) {
      throw adapterError(ErrorCode.DESTINATION_RATE_LIMITED, 'The destination is rate limiting.');
    }
    if (status === 502 || status === 503 || status === 504) {
      throw adapterError(ErrorCode.DESTINATION_UNAVAILABLE, 'The destination is unavailable.');
    }
    if (status < 200 || status >= 300) {
      throw adapterError(
        ErrorCode.DESTINATION_WRITE_FAILED,
        `The destination answered with status ${status}.`,
      );
    }

    const reference = definition.reference
      ? readReference(response.body, definition.reference, secret)
      : undefined;
    return {
      stored: true,
      destinationRef: reference ?? `${new URL(definition.url).host} answered ${status}`,
      detail: { status: String(status) },
    };
  } finally {
    wipe(response.body);
  }
}

/** `$.a.b[0].c` on a JSON response; dropped if it is not short, plain or secret-free. */
export function readReference(body: Buffer, path: string, secret: string): string | undefined {
  let node: unknown;
  try {
    node = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  for (const step of path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    if (node === null || typeof node !== 'object') return undefined;
    node =
      step[1] !== undefined
        ? (node as Record<string, unknown>)[step[1]]
        : (node as unknown[])[Number(step[2])];
  }
  if (typeof node !== 'string' && typeof node !== 'number') return undefined;
  const text = String(node);
  if (secret.length > 0 && text.includes(secret)) return undefined;
  return safeDisplay(text, 200);
}

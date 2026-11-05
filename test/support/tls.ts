/** A local HTTPS server with a throwaway certificate, for the http executor's tests. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { makeTempDir, removeTempDir } from './tmp.js';

export interface SeenRequest {
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface TlsServer {
  /** `https://localhost:<port>` */
  readonly base: string;
  /** PEM of the certificate, to pass as the trusted CA. */
  readonly ca: string;
  readonly seen: SeenRequest[];
  close(): Promise<void>;
}

/**
 * `handler` decides the answer; every request is recorded in `seen` first.
 * The certificate is valid for `localhost` and `127.0.0.1` for one day.
 */
export async function startTlsServer(
  handler: (
    request: SeenRequest,
  ) => { status: number; body?: string; headers?: Record<string, string> } | null,
): Promise<TlsServer> {
  const dir = makeTempDir();
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
  const ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const seen: SeenRequest[] = [];
  const server: Server = createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: ca },
    (request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        const seenRequest = { path: request.url ?? '/', headers: request.headers, body };
        seen.push(seenRequest);
        const answer = handler(seenRequest);
        if (!answer) return; // hang
        response.writeHead(answer.status, answer.headers ?? {});
        response.end(answer.body ?? '');
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    base: `https://localhost:${(server.address() as AddressInfo).port}`,
    ca,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeTempDir(dir);
    },
  };
}

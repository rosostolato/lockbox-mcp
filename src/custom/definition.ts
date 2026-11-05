/**
 * Agent-authored custom destinations: the definition itself
 * (docs/specs/custom-destinations, REQ-001…REQ-008, NFR-002, NFR-004).
 *
 * The agent writes a JSON definition; the human approves it as rendered; the
 * executor runs that same object. This module is the first gate: it accepts
 * only closed, bounded shapes, allows the credential exactly once and only in
 * places that are never logged or listed (a body, a header value, stdin, a
 * file template), and gives every accepted definition one canonical form and
 * one hash, so "what was approved" has a single, comparable identity.
 */

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { adapterError } from '../adapters/base.js';
import { ErrorCode } from '../errors.js';
import { looksLikeCredential } from '../redaction.js';

export const SECRET_PLACEHOLDER = '{{secret}}';
export const NAME_PLACEHOLDER = '{{name}}';

/** NFR-004 */
export const MAX_CANONICAL_BYTES = 16 * 1024;
const MAX_TEMPLATE = 64 * 1024;
const MAX_HEADERS = 32;
const MAX_ARGS = 64;

// -- placeholder rules (REQ-002) -----------------------------------------------

const ANY_BRACES = /\{\{[^}]*\}\}/g;

/**
 * Only `{{secret}}` and `{{name}}`, spelled exactly; nothing that a shell, a
 * template engine or an operator could mistake for an expansion.
 */
function expansionProblem(value: string): string | null {
  for (const match of value.match(ANY_BRACES) ?? []) {
    if (match !== SECRET_PLACEHOLDER && match !== NAME_PLACEHOLDER) {
      return `Only ${SECRET_PLACEHOLDER} and ${NAME_PLACEHOLDER} may be used as placeholders.`;
    }
  }
  const rest = value.replace(ANY_BRACES, '');
  if (rest.includes('{{') || rest.includes('}}')) {
    return 'Unbalanced placeholder braces.';
  }
  if (value.includes('${') || value.includes('$(') || value.includes('`')) {
    return 'Shell-style expansions are not allowed in a definition.';
  }
  return null;
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

const plain = (max: number): z.ZodString =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes('\0'), 'NUL characters are not allowed.')
    .superRefine((value, ctx) => {
      const problem = expansionProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    });

/** A string that must not carry the credential at all. */
const noSecret = (max: number): z.ZodString =>
  plain(max).refine(
    (value) => !value.includes(SECRET_PLACEHOLDER),
    `${SECRET_PLACEHOLDER} is not allowed here.`,
  );

/** A string that must not contain any placeholder at all. */
const literal = (max: number): z.ZodString =>
  plain(max).refine((value) => !value.includes('{{'), 'Placeholders are not allowed here.');

const label = literal(64)
  .min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed.');

// -- http (REQ-004, REQ-005) -----------------------------------------------------

const httpsUrl = literal(2048).superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Not a valid URL.' });
    return;
  }
  if (url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'Only https is allowed.' });
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: 'custom', message: 'Credentials in the URL are not allowed.' });
  }
});

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_|~-]{1,64}$/, 'Not a valid header name.');

const headerValue = plain(1024).refine(
  (value) => !/[\r\n]/.test(value),
  'Header values cannot contain line breaks.',
);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** In a JSON body a placeholder is a whole string leaf, never part of one. */
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    plain(MAX_TEMPLATE).refine(
      (value) =>
        !value.includes('{{') || value === SECRET_PLACEHOLDER || value === NAME_PLACEHOLDER,
      'In a JSON body a placeholder must be the whole string value.',
    ),
    z.number().refine(Number.isFinite, 'Numbers must be finite.'),
    z.boolean(),
    z.null(),
    z.array(jsonValue).max(256),
    z.record(literal(256), jsonValue),
  ]),
);

const httpBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('json'), value: jsonValue }).strict(),
  z
    .object({
      type: z.literal('text'),
      value: plain(MAX_TEMPLATE),
      contentType: literal(128).min(1),
    })
    .strict(),
  z.object({ type: z.literal('none') }).strict(),
]);

const jsonPath = z
  .string()
  .max(128)
  .regex(/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,4}\])+$/, 'Use a simple path such as $.data.id.');

const httpDefinition = z
  .object({
    kind: z.literal('http'),
    label,
    url: httpsUrl,
    method: z.enum(['POST', 'PUT', 'PATCH']),
    headers: z
      .record(headerName, headerValue)
      .refine((headers) => Object.keys(headers).length <= MAX_HEADERS, 'Too many headers.'),
    body: httpBody,
    reference: jsonPath.optional(),
  })
  .strict();

// -- command (REQ-006, REQ-007) --------------------------------------------------

const absolutePath = literal(1024).refine(isAbsolute, 'Must be an absolute path.');

const commandDefinition = z
  .object({
    kind: z.literal('command'),
    label,
    executable: absolutePath,
    args: z.array(noSecret(1024)).max(MAX_ARGS),
    cwd: absolutePath.optional(),
    stdin: plain(MAX_TEMPLATE),
  })
  .strict();

// -- file (REQ-008) --------------------------------------------------------------

const fileDefinition = z
  .object({
    kind: z.literal('file'),
    label,
    path: literal(512).min(1),
    template: plain(MAX_TEMPLATE),
    // `env` sets one variable in a .env file and keeps every other line.
    mode: z.enum(['create', 'replace', 'env']),
  })
  .strict();

/** `env` mode: the template is exactly `KEY={{secret}}`, KEY literal or `{{name}}`. */
export const ENV_TEMPLATE = /^(\{\{name\}\}|[A-Za-z_][A-Za-z0-9_]{0,127})=\{\{secret\}\}\n?$/;

export const customDefinitionSchema = z.discriminatedUnion('kind', [
  httpDefinition,
  commandDefinition,
  fileDefinition,
]);

export type CustomDefinition = z.infer<typeof customDefinitionSchema>;
export type HttpDefinition = z.infer<typeof httpDefinition>;
export type CommandDefinition = z.infer<typeof commandDefinition>;
export type FileDefinition = z.infer<typeof fileDefinition>;

// -- filling placeholders at execution ------------------------------------------

/** Put the credential and its name into a text template. */
export function fillText(template: string, secret: string, name: string): string {
  return template
    .split(SECRET_PLACEHOLDER)
    .map((part) => part.split(NAME_PLACEHOLDER).join(name))
    .join(secret);
}

/**
 * Put the credential into a JSON body. Placeholders are whole string leaves
 * (the schema guarantees it), so the value is inserted as a JSON string by
 * `JSON.stringify` later — never by string concatenation.
 */
export function fillJson(value: unknown, secret: string, name: string): unknown {
  if (value === SECRET_PLACEHOLDER) return secret;
  if (value === NAME_PLACEHOLDER) return name;
  if (Array.isArray(value)) return value.map((item) => fillJson(item, secret, name));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillJson(item, secret, name)]),
    );
  }
  return value;
}

// -- canonical form and identity (NFR-002, REQ-014) -----------------------------

/**
 * RFC 8785 JSON Canonicalization: object keys sorted by UTF-16 code units, no
 * insignificant whitespace, ECMAScript number and string serialization.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  throw new TypeError(`cannot canonicalize ${typeof value}`);
}

export function definitionHash(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface ParsedDefinition {
  readonly definition: CustomDefinition;
  readonly canonical: string;
  readonly hash: string;
}

/** Every string in the definition, wherever it sits. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      strings(item, out);
    }
  }
  return out;
}

/** Where the credential lands, as text, for the exactly-once rule. */
function secretSlots(definition: CustomDefinition): string[] {
  switch (definition.kind) {
    case 'http': {
      const slots = Object.values(definition.headers);
      if (definition.body.type === 'json') slots.push(...strings(definition.body.value));
      if (definition.body.type === 'text') slots.push(definition.body.value);
      return slots;
    }
    case 'command':
      return [definition.stdin];
    case 'file':
      return [definition.template];
  }
}

/**
 * Validate an agent-supplied definition and give it its identity.
 *
 * Refusals use INVALID_TARGET and name the field, never the value: a value the
 * agent supplied may be exactly the thing that must not be echoed.
 */
export function parseDefinition(input: unknown): ParsedDefinition {
  // REQ-003: a definition must never already carry a credential.
  if (strings(input).some(looksLikeCredential)) {
    throw adapterError(
      ErrorCode.INVALID_TARGET,
      `The definition contains what looks like a credential. Use ${SECRET_PLACEHOLDER} instead.`,
    );
  }

  const parsed = customDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'definition';
    throw adapterError(
      ErrorCode.INVALID_TARGET,
      `The destination definition is not valid at ${where}: ${issue?.message ?? 'invalid'}`,
    );
  }

  const definition = parsed.data;
  if (
    definition.kind === 'file' &&
    definition.mode === 'env' &&
    !ENV_TEMPLATE.test(definition.template)
  ) {
    throw adapterError(
      ErrorCode.INVALID_TARGET,
      'In env mode the template is KEY={{secret}}, where KEY is a variable name or {{name}}.',
    );
  }
  const occurrences = secretSlots(definition).reduce(
    (total, slot) => total + count(slot, SECRET_PLACEHOLDER),
    0,
  );
  if (occurrences !== 1) {
    throw adapterError(
      ErrorCode.INVALID_TARGET,
      `The definition must use ${SECRET_PLACEHOLDER} exactly once (found ${occurrences}).`,
    );
  }

  const canonical = canonicalize(definition);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_BYTES) {
    throw adapterError(ErrorCode.INVALID_TARGET, 'The destination definition is too large.');
  }
  return { definition, canonical, hash: definitionHash(canonical) };
}

/**
 * What the human reads about a custom destination
 * (docs/specs/custom-destinations, REQ-009…REQ-011, NFR-002).
 *
 * Two levels, on purpose. The main screen gets one destination line and any
 * risk signal, so the request reads at a glance. The full operation, rendered
 * from the same canonical JSON the executor runs, sits behind one closed
 * disclosure for the human who wants to verify it. Nothing here touches the
 * credential: `{{secret}}` is drawn as a masked chip.
 */

import { isIP } from 'node:net';

import type { NormalizedTarget } from '../model.js';
import { safeDisplay } from '../redaction.js';
import {
  NAME_PLACEHOLDER,
  SECRET_PLACEHOLDER,
  type CommandDefinition,
  type CustomDefinition,
  type FileDefinition,
  type HttpDefinition,
} from './definition.js';

/** Long enough for any bounded template; display must never cut what runs. */
const BLOCK_LIMIT = 70_000;

const STANDARD_BIN_DIRS = [
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
  '/usr/local/bin/',
  '/opt/homebrew/bin/',
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line of untrusted text, neutralised and escaped. */
function text(value: string, max = 512): string {
  return escapeHtml(safeDisplay(value, max));
}

/**
 * Multi-line untrusted text for a `<pre>`, line by line so newlines survive
 * `safeDisplay`, with the placeholders drawn as chips.
 */
function block(value: string, logicalName: string): string {
  return value
    .split('\n')
    .map((line) => placeholders(escapeHtml(safeDisplay(line, BLOCK_LIMIT)), logicalName))
    .join('\n');
}

function placeholders(escaped: string, logicalName: string): string {
  return escaped
    .split(SECRET_PLACEHOLDER)
    .join(`<span class="chip-secret">•••• ${text(logicalName, 128)}</span>`)
    .split(NAME_PLACEHOLDER)
    .join(`<span class="chip-name">${text(logicalName, 128)}</span>`);
}

export function isCustomTarget(target: NormalizedTarget): boolean {
  return target.adapterId === 'custom' && Boolean(target.fields.definition_json);
}

function definitionOf(target: NormalizedTarget): CustomDefinition {
  return JSON.parse(target.fields.definition_json ?? '{}') as CustomDefinition;
}

/** REQ-009: `label · short target`, the one line the main screen shows. */
export function destinationLine(target: NormalizedTarget): string {
  const saved =
    target.fields.saved_status === 'saved' && target.fields.saved_name
      ? `Saved <span class="sep">·</span> ${text(target.fields.saved_name, 40)} <span class="sep">·</span> `
      : `${text(target.resourceLabel, 64)} <span class="sep">·</span> `;
  return `<div class="path">${saved}${text(target.accountLabel ?? '', 256)}</div>`;
}

/**
 * REQ-011: one plain sentence per signal, shown without opening anything.
 * `knownHosts` are hosts the human approved before (saved destinations).
 */
export function riskSignals(
  target: NormalizedTarget,
  knownHosts: ReadonlySet<string> = new Set(),
): string[] {
  const signals: string[] = [];
  const { fields } = target;
  if (fields.saved_status === 'changed') {
    signals.push(`Changed since you saved it as ${fields.saved_name ?? 'a trusted destination'}`);
  }
  if (fields.kind === 'http' && fields.host) {
    const host = fields.host;
    if (!knownHosts.has(host) && fields.host_known !== 'yes') {
      signals.push(`First time sending to ${host}`);
    }
    if (host.split('.').some((label) => label.startsWith('xn--'))) {
      signals.push(`Host uses non-ASCII characters, shown here as ${host}`);
    }
    if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) {
      signals.push('Sends to an IP address instead of a host name');
    }
  }
  if (fields.kind === 'command' && fields.executable_realpath) {
    const path = fields.executable_realpath;
    if (!STANDARD_BIN_DIRS.some((dir) => path.startsWith(dir))) {
      signals.push(`Runs a program outside the system folders: ${path}`);
    }
  }
  return signals;
}

export function signalLines(signals: readonly string[]): string {
  return signals.map((signal) => `<p class="signal">⚠ ${text(signal)}</p>`).join('');
}

/** REQ-010: the operation, rendered from the canonical JSON, behind a closed disclosure. */
export function exactView(target: NormalizedTarget, logicalName: string, notice?: string): string {
  const definition = definitionOf(target);
  let operation: string;
  switch (definition.kind) {
    case 'http':
      operation = httpView(definition, logicalName);
      break;
    case 'command':
      operation = commandView(definition, target, logicalName);
      break;
    case 'file':
      operation = fileView(definition, target, logicalName);
      break;
  }
  // Non-ASCII shown as \uXXXX: a homograph (Cyrillic "а" for Latin "a") must
  // look different here, not identical to the name it imitates.
  const pretty = JSON.stringify(JSON.parse(target.fields.definition_json ?? '{}'), null, 2).replace(
    /[^\x20-\x7e\n]/g,
    (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  );
  return (
    '<details class="exact"><summary>See exactly what will be sent</summary>' +
    (notice ? `<p class="exact-note">${text(notice)}</p>` : '') +
    operation +
    '<p class="exact-label">Definition JSON · sha256 ' +
    `<code>${text(target.fields.definition_hash ?? '', 80)}</code></p>` +
    `<pre class="exact-json">${block(pretty, logicalName)}</pre>` +
    '</details>'
  );
}

function httpView(definition: HttpDefinition, logicalName: string): string {
  const headers = Object.entries(definition.headers);
  let body: string;
  switch (definition.body.type) {
    case 'json':
      body = block(JSON.stringify(definition.body.value, null, 2), logicalName);
      break;
    case 'text':
      body = block(definition.body.value, logicalName);
      break;
    case 'none':
      body = '';
      break;
  }
  return (
    // The URL as it will be requested: host in its ASCII (punycode) form.
    `<p class="exact-op"><strong>${text(definition.method, 8)}</strong> ` +
    `${text(new URL(definition.url).href, 2048)}</p>` +
    (headers.length > 0
      ? '<table class="exact-headers">' +
        headers
          .map(
            ([name, value]) =>
              `<tr><th>${text(name, 64)}</th><td>${block(value, logicalName)}</td></tr>`,
          )
          .join('') +
        '</table>'
      : '') +
    (body ? `<p class="exact-label">Body</p><pre>${body}</pre>` : '') +
    (definition.reference
      ? `<p class="exact-label">Reference returned to the agent: <code>${text(definition.reference, 128)}</code></p>`
      : '')
  );
}

function commandView(
  definition: CommandDefinition,
  target: NormalizedTarget,
  logicalName: string,
): string {
  return (
    `<p class="exact-op"><strong>Runs</strong> ${text(target.fields.executable_realpath ?? '', 1024)}</p>` +
    `<p class="exact-label">In ${text(target.fields.cwd ?? '', 1024)}, no shell, with these arguments</p>` +
    `<ol class="exact-args">${definition.args.map((arg) => `<li><code>${placeholders(text(arg, 1024), logicalName)}</code></li>`).join('')}</ol>` +
    '<p class="exact-label">Standard input</p>' +
    `<pre>${block(definition.stdin, logicalName)}</pre>`
  );
}

function fileView(
  definition: FileDefinition,
  target: NormalizedTarget,
  logicalName: string,
): string {
  return (
    `<p class="exact-op"><strong>${definition.mode === 'replace' ? 'Replaces' : 'Creates'}</strong> ` +
    `${text(target.fields.path ?? '', 1024)}</p>` +
    '<p class="exact-label">Content</p>' +
    `<pre>${block(definition.template, logicalName)}</pre>`
  );
}

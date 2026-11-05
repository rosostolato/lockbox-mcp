/**
 * Custom destinations: the agent describes where the credential goes, the human
 * approves it as rendered (docs/specs/custom-destinations).
 *
 * The target is `{ definition }`. `normalizeTarget` validates it, gives it its
 * canonical form and hash, and freezes everything that could drift between
 * approval and execution — the executable's real path and content hash, the
 * file's resolved path — into the target. From there the existing snapshot,
 * digest, Stage A/B and revise machinery apply unchanged: what the human
 * approves and what runs are the same frozen object.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';

import { runCommand, sha256File } from '../custom/command.js';
import { definitionHash, parseDefinition, type CustomDefinition } from '../custom/definition.js';
import { writeFile } from '../custom/file.js';
import { sendHttp } from '../custom/http.js';
import { SavedDestinations } from '../custom/store.js';
import { ErrorCode } from '../errors.js';
import {
  DestinationClass,
  Environment,
  RiskLevel,
  normalizedTarget,
  type NormalizedTarget,
  type PreflightResult,
  type RiskAssessment,
  type StoreResult,
  type ValidationResult,
} from '../model.js';
import type { SecretBuffer } from '../secretBuffer.js';
import { SecretDestinationAdapter, adapterError, type JsonSchema } from './base.js';
import {
  containingRoot,
  findKeyLine,
  gitHygiene,
  readWithoutFollowingSymlinks,
  resolveAllowedPath,
  validateLocalPath,
} from '../custom/localFile.js';
import { envKey } from '../custom/file.js';
import { CUSTOM_ADAPTER_ID } from './registry.js';

export class CustomDestinationAdapter extends SecretDestinationAdapter {
  readonly id = CUSTOM_ADAPTER_ID;
  readonly displayName = 'Custom destination';
  // The adapter's widest class; each target carries its own (http, command, file).
  readonly destinationClass = DestinationClass.ARBITRARY_NETWORK;
  override readonly riskClass = RiskLevel.HIGH;

  targetSchema(): JsonSchema {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        definition: {
          type: 'object',
          description:
            'Where and how to store the credential: an http request, a local command or a ' +
            `local file, with {{secret}} exactly once where the value goes. Kinds enabled: ` +
            `${this.config.customKinds.join(', ')}. secret_destinations returns the full ` +
            'contract and examples.',
        },
      },
    };
  }

  async normalizeTarget(
    target: Readonly<Record<string, unknown>>,
    context: { name: string; environmentHint: Environment },
  ): Promise<NormalizedTarget> {
    const store = SavedDestinations.for(this.config);
    let input: unknown;
    let saved: { name: string; status: 'saved' | 'changed'; at: string } | undefined;
    if (typeof target.saved === 'string') {
      const entry = await store.get(target.saved);
      if (!entry) {
        throw adapterError(
          ErrorCode.UNKNOWN_DESTINATION,
          'There is no saved destination with that name.',
        );
      }
      input = entry.definition;
      // A changed entry is reviewed as new (REQ-014); its name only explains why.
      saved = {
        name: entry.name,
        status: entry.intact ? 'saved' : 'changed',
        at: entry.approvedAt,
      };
    } else {
      const keys = Object.keys(target);
      if (keys.length !== 1 || keys[0] !== 'definition') {
        throw adapterError(ErrorCode.INVALID_TARGET, 'A custom destination needs a definition.');
      }
      input = target.definition;
    }

    const { definition, canonical, hash } = parseDefinition(input);
    if (!saved) {
      const match = await store.byHash(hash);
      if (match) saved = { name: match.name, status: 'saved', at: match.approvedAt };
    }
    if (!this.config.customKinds.includes(definition.kind)) {
      throw adapterError(
        ErrorCode.DESTINATION_NOT_PERMITTED,
        `The operator does not allow ${definition.kind} destinations (LOCKBOX_CUSTOM_KINDS).`,
      );
    }

    const common = {
      kind: definition.kind,
      label: definition.label,
      name: context.name,
      definition_hash: hash,
      definition_json: canonical,
    };
    const shape = await this.#shape(definition, context.name);
    if (shape.fields.host && (await store.knownHosts()).has(shape.fields.host)) {
      shape.fields.host_known = 'yes';
    }
    if (saved) {
      Object.assign(common, {
        saved_name: saved.name,
        saved_status: saved.status,
        saved_at: saved.at,
      });
    }
    return normalizedTarget({
      adapterId: this.id,
      destinationClass: shape.destinationClass,
      providerLabel: shape.providerLabel,
      accountLabel: shape.short,
      resourceLabel: definition.label,
      environment: this.environmentFor(
        context.environmentHint,
        definition.label,
        ...shape.evidence,
      ),
      fields: { ...common, ...shape.fields },
    });
  }

  async #shape(
    definition: CustomDefinition,
    name: string,
  ): Promise<{
    destinationClass: DestinationClass;
    providerLabel: string;
    short: string;
    evidence: string[];
    fields: Record<string, string>;
  }> {
    switch (definition.kind) {
      case 'http': {
        const url = new URL(definition.url);
        // WHATWG URL already gives the ASCII (punycode) form of the host.
        const host = url.hostname.toLowerCase();
        const allowed = this.config.customHttpHosts;
        if (allowed.length > 0 && !allowed.includes(host)) {
          throw adapterError(
            ErrorCode.DESTINATION_NOT_PERMITTED,
            'The operator does not allow this host (LOCKBOX_CUSTOM_HTTP_HOSTS).',
          );
        }
        return {
          destinationClass: DestinationClass.ARBITRARY_NETWORK,
          providerLabel: 'HTTPS request',
          short: host,
          evidence: [host, url.pathname],
          fields: { host },
        };
      }
      case 'command': {
        const executable = await resolveExecutable(definition.executable);
        const cwd = definition.cwd ?? this.config.envAllowedRoots[0] ?? process.cwd();
        const cwdStats = await fs.stat(cwd).catch(() => null);
        if (!isAbsolute(cwd) || !cwdStats?.isDirectory()) {
          throw adapterError(ErrorCode.INVALID_TARGET, 'The working directory does not exist.');
        }
        return {
          destinationClass: DestinationClass.LOCAL_COMMAND,
          providerLabel: 'Local command',
          short: basename(executable.realpath),
          evidence: definition.args,
          fields: {
            executable_realpath: executable.realpath,
            executable_sha256: executable.sha256,
            cwd,
          },
        };
      }
      case 'file': {
        // Only .env names unless the operator says otherwise: anything else under
        // a root (`public/robots.txt`, a build artefact) may be served or committed.
        const path = resolveAllowedPath(this.config, definition.path, {
          envNamesOnly: !this.config.envAllowAnyFilename,
        });
        const root = containingRoot(this.config, path);
        const relativePath = root ? relative(root, path) : basename(path);
        const fields: Record<string, string> = { path, relative: relativePath };
        // `env` mode confirms as `path:KEY`, the variable it sets.
        if (definition.mode === 'env') fields.key = envKey(definition, name);
        return {
          destinationClass: DestinationClass.LOCAL_PLAINTEXT,
          providerLabel: 'Local file',
          short: relativePath,
          evidence: [relativePath],
          fields,
        };
      }
    }
  }

  override validateTarget(target: NormalizedTarget): Promise<ValidationResult> {
    if (target.fields.kind === 'file') return validateLocalPath(target.fields.path ?? '');
    return Promise.resolve({ ok: true });
  }

  override async preflight(target: NormalizedTarget): Promise<PreflightResult> {
    if (target.fields.kind !== 'file') return { ok: true };
    const path = target.fields.path ?? '';
    const hygiene = await gitHygiene(this.config, path);
    if (!hygiene.ok) return hygiene;
    const definition = definitionOf(target);
    if (definition.kind !== 'file') return { ok: true };
    if (hygiene.exists && definition.mode === 'create') {
      return {
        ok: false,
        code: ErrorCode.DESTINATION_CONFLICT,
        message: 'The file already exists. A definition that overwrites it uses mode "replace".',
      };
    }
    if (definition.mode === 'env' && hygiene.exists) {
      const key = envKey(definition, target.fields.name ?? '');
      let content: string;
      try {
        content = await readWithoutFollowingSymlinks(path);
      } catch {
        return {
          ok: false,
          code: ErrorCode.DESTINATION_NOT_PERMITTED,
          message: 'The destination file could not be read safely.',
        };
      }
      const variableExists = findKeyLine(content.split('\n'), key) !== null;
      return {
        ok: true,
        exists: variableExists,
        notes: [
          ...hygiene.notes,
          ...(variableExists ? [`${key} already has a value and will be replaced.`] : []),
        ],
      };
    }
    return { ok: true, exists: hygiene.exists, notes: hygiene.notes };
  }

  calculateRisk(): Promise<RiskAssessment> {
    return Promise.resolve({
      level: RiskLevel.HIGH,
      reasons: ['Every custom destination is reviewed and confirmed twice.'],
      requiresStageB: true,
    });
  }

  /** Run exactly the frozen definition the human approved. */
  async store(secret: SecretBuffer, target: NormalizedTarget): Promise<StoreResult> {
    const canonical = target.fields.definition_json ?? '';
    if (definitionHash(canonical) !== target.fields.definition_hash) {
      throw adapterError(ErrorCode.SNAPSHOT_MISMATCH, 'The approved destination changed.');
    }
    const definition = definitionOf(target);
    const name = target.fields.name ?? '';
    const timeoutMs = this.config.adapterTimeoutSeconds * 1000;

    switch (definition.kind) {
      case 'http':
        return sendHttp(definition, secret, name, {
          timeoutMs,
          allowPrivate: this.config.customHttpAllowPrivate,
          ...(this.httpCa ? { ca: this.httpCa } : {}),
        });
      case 'command':
        return runCommand(
          definition,
          {
            realpath: target.fields.executable_realpath ?? '',
            sha256: target.fields.executable_sha256 ?? '',
            cwd: target.fields.cwd ?? '',
          },
          secret,
          name,
          timeoutMs,
        );
      case 'file':
        return writeFile(
          definition,
          { path: target.fields.path ?? '', relative: target.fields.relative ?? '' },
          secret,
          name,
          this.config,
        );
    }
  }

  /** Extra trusted CA for `http`, set only by tests against a local TLS server. */
  httpCa: string | undefined;
}

function definitionOf(target: NormalizedTarget): CustomDefinition {
  return JSON.parse(target.fields.definition_json ?? '{}') as CustomDefinition;
}

/**
 * Pin the program that will receive the credential: its real path (no symlink
 * left to swap) and a hash of its bytes, re-checked before it runs.
 */
async function resolveExecutable(path: string): Promise<{ realpath: string; sha256: string }> {
  const realpath = await fs.realpath(path).catch(() => null);
  const stats = realpath ? await fs.stat(realpath).catch(() => null) : null;
  if (!realpath || !stats?.isFile()) {
    throw adapterError(ErrorCode.INVALID_TARGET, 'The executable does not exist.');
  }
  const runnable = await fs
    .access(realpath, fsConstants.X_OK)
    .then(() => true)
    .catch(() => false);
  if (!runnable) {
    throw adapterError(ErrorCode.INVALID_TARGET, 'The file is not executable.');
  }
  return { realpath, sha256: await sha256File(realpath) };
}

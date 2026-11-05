/**
 * Adapter registry (SPEC.md §16, §17).
 *
 * Only adapters registered here can ever be selected. The `arbitrary-network`
 * destination class is rejected at registration time for every adapter but
 * `custom`, whose destinations are agent-written definitions that the human
 * reviews in full and always confirms twice (docs/specs/custom-destinations,
 * the recorded deviation from SPEC.md §16). No other code path can add one.
 */

import type { LockboxConfig } from '../config.js';
import { ErrorCode, lockboxError } from '../errors.js';
import { DestinationClass } from '../model.js';
import type { SecretDestinationAdapter } from './base.js';

export const CUSTOM_ADAPTER_ID = 'custom';
/** `saved:<name>` in `secret_store`: a custom destination the human saved earlier. */
export const SAVED_DESTINATION = /^saved:([a-z0-9-]{1,40})$/;

export class AdapterRegistry {
  #adapters = new Map<string, SecretDestinationAdapter>();

  constructor(adapters: readonly SecretDestinationAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: SecretDestinationAdapter): void {
    if (
      adapter.destinationClass === DestinationClass.ARBITRARY_NETWORK &&
      adapter.id !== CUSTOM_ADAPTER_ID
    ) {
      throw new Error('arbitrary-network destinations are not permitted');
    }
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`duplicate adapter id: ${adapter.id}`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(adapterId: unknown): SecretDestinationAdapter {
    const adapter = typeof adapterId === 'string' ? this.#adapters.get(adapterId) : undefined;
    if (!adapter) {
      throw lockboxError(
        ErrorCode.UNKNOWN_DESTINATION,
        'The requested destination is not available.',
      );
    }
    return adapter;
  }

  has(adapterId: unknown): boolean {
    return typeof adapterId === 'string' && this.#adapters.has(adapterId);
  }

  list(): readonly SecretDestinationAdapter[] {
    return [...this.#adapters.values()];
  }

  ids(): readonly string[] {
    return [...this.#adapters.keys()];
  }
}

/**
 * Build the adapters enabled for this process: the custom adapter only. Every
 * destination is one the agent describes and the human approves
 * (docs/specs/custom-destinations, REQ-020).
 */
export async function defaultRegistry(config: LockboxConfig): Promise<AdapterRegistry> {
  const { CustomDestinationAdapter } = await import('./custom.js');
  const candidates: SecretDestinationAdapter[] = [new CustomDestinationAdapter(config)];
  const allowed = config.enabledAdapters;
  return new AdapterRegistry(
    allowed ? candidates.filter((adapter) => allowed.includes(adapter.id)) : candidates,
  );
}

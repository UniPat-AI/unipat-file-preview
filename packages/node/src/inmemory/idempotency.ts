import type {
  IdempotencyStore,
} from '../ports.js';

interface Slot {
  key: string;
  scope: string;
  requestHash: string;
  operationId: string;
  status: 'in_progress' | 'complete';
  expiresAt: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly slots = new Map<string, Slot>();
  private counter = 0;

  async reserve(input: {
    scope: string;
    key: string;
    requestHash: string;
    ttlMs: number;
  }): Promise<
    | { status: 'reserved'; operationId: string }
    | { status: 'replay'; operationId: string }
    | { status: 'conflict' }
    | { status: 'in_progress' }
  > {
    this.gc();
    const slotKey = `${input.scope}::${input.key}`;
    const existing = this.slots.get(slotKey);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        return { status: 'conflict' };
      }
      if (existing.status === 'in_progress') {
        return { status: 'in_progress' };
      }
      return { status: 'replay', operationId: existing.operationId };
    }
    const operationId = `op_${++this.counter}`;
    this.slots.set(slotKey, {
      key: input.key,
      scope: input.scope,
      requestHash: input.requestHash,
      operationId,
      status: 'in_progress',
      expiresAt: Date.now() + input.ttlMs,
    });
    return { status: 'reserved', operationId };
  }

  async complete(input: {
    scope: string;
    key: string;
    operationId: string;
  }): Promise<void> {
    const slotKey = `${input.scope}::${input.key}`;
    const slot = this.slots.get(slotKey);
    if (!slot || slot.operationId !== input.operationId) return;
    slot.status = 'complete';
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.slots) {
      if (v.expiresAt <= now) this.slots.delete(k);
    }
  }
}

import type { PreviewEventEnvelope, PreviewState } from '@unipat/file-preview-contracts';

export interface PreviewEventBusOptions {
  readonly ringSize?: number;
}

export interface PreviewEventSubscription {
  readonly close: () => void;
}

type Listener = (event: PreviewEventEnvelope) => void;

interface Slot {
  ring: PreviewEventEnvelope[];
  head: number;
  size: number;
  counter: number;
  listeners: Set<Listener>;
}

/**
 * 内存版预览事件总线：
 *  - 每个 previewId 单独维护环形缓冲（默认容量 100）；
 *  - publish 单调递增 eventId（同一进程内），配合 SSE 的 Last-Event-ID 用于续传；
 *  - since(eventId) 返回严格大于 eventId 的历史事件。
 *
 * 生产接入建议替换为 Redis Stream / Kafka，但对外接口保持稳定。
 */
export class PreviewEventBus {
  private readonly ringSize: number;
  private readonly slots = new Map<string, Slot>();

  constructor(opts: PreviewEventBusOptions = {}) {
    this.ringSize = opts.ringSize ?? 100;
  }

  publishState(previewId: string, state: PreviewState): PreviewEventEnvelope {
    const slot = this.ensureSlot(previewId);
    slot.counter += 1;
    const envelope: PreviewEventEnvelope = {
      eventId: slot.counter,
      previewId,
      type: 'preview-state',
      state,
      emittedAt: new Date().toISOString(),
    };
    this.pushToRing(slot, envelope);
    for (const listener of slot.listeners) {
      try {
        listener(envelope);
      } catch {
        /* 单个订阅方异常不影响其他订阅 */
      }
    }
    return envelope;
  }

  publishHeartbeat(previewId: string): PreviewEventEnvelope {
    const slot = this.ensureSlot(previewId);
    slot.counter += 1;
    const envelope: PreviewEventEnvelope = {
      eventId: slot.counter,
      previewId,
      type: 'heartbeat',
      state: null,
      emittedAt: new Date().toISOString(),
    };
    for (const listener of slot.listeners) {
      try {
        listener(envelope);
      } catch {
        /* noop */
      }
    }
    return envelope;
  }

  since(previewId: string, lastEventId: number): PreviewEventEnvelope[] {
    const slot = this.slots.get(previewId);
    if (!slot || slot.size === 0) return [];
    const out: PreviewEventEnvelope[] = [];
    const start = (slot.head - slot.size + slot.ring.length) % slot.ring.length;
    for (let i = 0; i < slot.size; i++) {
      const idx = (start + i) % slot.ring.length;
      const evt = slot.ring[idx]!;
      if (evt.eventId > lastEventId) out.push(evt);
    }
    return out;
  }

  subscribe(
    previewId: string,
    listener: Listener,
  ): PreviewEventSubscription {
    const slot = this.ensureSlot(previewId);
    slot.listeners.add(listener);
    return {
      close: () => {
        slot.listeners.delete(listener);
      },
    };
  }

  private ensureSlot(previewId: string): Slot {
    let slot = this.slots.get(previewId);
    if (!slot) {
      slot = {
        ring: new Array(this.ringSize),
        head: 0,
        size: 0,
        counter: 0,
        listeners: new Set(),
      };
      this.slots.set(previewId, slot);
    }
    return slot;
  }

  private pushToRing(slot: Slot, envelope: PreviewEventEnvelope): void {
    slot.ring[slot.head] = envelope;
    slot.head = (slot.head + 1) % slot.ring.length;
    if (slot.size < slot.ring.length) slot.size += 1;
  }
}

export function formatSseEvent(envelope: PreviewEventEnvelope): string {
  const lines = [
    `id: ${envelope.eventId}`,
    `event: ${envelope.type}`,
    `data: ${JSON.stringify(envelope)}`,
    '',
    '',
  ];
  return lines.join('\n');
}

import { CLIENT_MAX_PARALLEL_REQUESTS } from './contracts.js';

export interface EnqueueOptions {
  readonly signal?: AbortSignal;
  /** 数值越大越优先，默认 0；同优先级 FIFO。 */
  readonly priority?: number;
  /**
   * 用于 per-key 并发限制的分组键。
   * 若同一 key 已达到 `perKeyMaxParallel` 上限，任务会先在队列里等；
   * 未指定则不参与 per-key 限流。
   */
  readonly key?: string;
}

interface QueuedTask<T> {
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly priority: number;
  readonly seq: number;
  readonly key: string | undefined;
}

export interface RequestQueueOptions {
  readonly maxParallel?: number;
  /**
   * 每个 key 允许的并发上限。仅在 enqueue 时指定了 key 才生效。
   * 未设置或 <=0 时视为不启用 per-key 限流。
   */
  readonly perKeyMaxParallel?: number;
}

export class RequestQueue {
  private readonly maxParallel: number;
  private readonly perKeyMaxParallel: number;
  private inflight = 0;
  private readonly perKeyInflight = new Map<string, number>();
  private readonly queue: QueuedTask<unknown>[] = [];
  private seqCounter = 0;

  constructor(options: RequestQueueOptions = {}) {
    const limit = options.maxParallel ?? CLIENT_MAX_PARALLEL_REQUESTS;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('maxParallel 必须为 >=1 的整数');
    }
    this.maxParallel = limit;
    const perKey = options.perKeyMaxParallel ?? 0;
    if (!Number.isInteger(perKey) || perKey < 0) {
      throw new Error('perKeyMaxParallel 必须为 >=0 的整数');
    }
    this.perKeyMaxParallel = perKey;
  }

  /**
   * 入队一个异步任务。
   *
   * 两种调用形式（后者向后兼容旧签名 `enqueue(run, signal?)`）：
   *   queue.enqueue(run, { signal, priority, key })
   *   queue.enqueue(run, signal)
   */
  enqueue<T>(
    run: () => Promise<T>,
    optionsOrSignal?: EnqueueOptions | AbortSignal,
  ): Promise<T> {
    const opts: EnqueueOptions = isAbortSignalLike(optionsOrSignal)
      ? { signal: optionsOrSignal }
      : (optionsOrSignal ?? {});
    const signal = opts.signal;

    if (signal?.aborted) {
      return Promise.reject(makeAbortError());
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        run,
        resolve,
        reject,
        signal,
        priority: opts.priority ?? 0,
        seq: this.seqCounter++,
        key: opts.key,
      };

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(
            task as unknown as QueuedTask<unknown>,
          );
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(makeAbortError());
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      insertByPriority(this.queue, task as unknown as QueuedTask<unknown>);
      this.pump();
    });
  }

  private pump(): void {
    // 循环选出下一个满足 per-key 限流的任务；若最靠前的任务被 per-key 限流，
    // 就跳过它继续找下一个可执行任务，直到无法再启动。
    while (this.inflight < this.maxParallel && this.queue.length > 0) {
      const idx = this.pickNextRunnableIndex();
      if (idx === -1) return;
      const task = this.queue.splice(idx, 1)[0]!;
      if (task.signal?.aborted) {
        task.reject(makeAbortError());
        continue;
      }
      this.inflight += 1;
      if (task.key !== undefined) {
        this.perKeyInflight.set(
          task.key,
          (this.perKeyInflight.get(task.key) ?? 0) + 1,
        );
      }
      task.run().then(
        (value) => this.finishTask(task, () => task.resolve(value)),
        (err) => this.finishTask(task, () => task.reject(err)),
      );
    }
  }

  private pickNextRunnableIndex(): number {
    if (this.perKeyMaxParallel <= 0) return this.queue.length ? 0 : -1;
    for (let i = 0; i < this.queue.length; i++) {
      const t = this.queue[i]!;
      if (t.key === undefined) return i;
      const current = this.perKeyInflight.get(t.key) ?? 0;
      if (current < this.perKeyMaxParallel) return i;
    }
    return -1;
  }

  private finishTask(task: QueuedTask<unknown>, notify: () => void): void {
    this.inflight -= 1;
    if (task.key !== undefined) {
      const current = this.perKeyInflight.get(task.key) ?? 0;
      if (current <= 1) this.perKeyInflight.delete(task.key);
      else this.perKeyInflight.set(task.key, current - 1);
    }
    notify();
    this.pump();
  }
}

function insertByPriority(
  queue: QueuedTask<unknown>[],
  task: QueuedTask<unknown>,
): void {
  // 二分查找插入位置：priority DESC，同优先级 seq ASC（FIFO）。
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cur = queue[mid]!;
    if (
      cur.priority > task.priority ||
      (cur.priority === task.priority && cur.seq <= task.seq)
    ) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  queue.splice(lo, 0, task);
}

function isAbortSignalLike(
  value: EnqueueOptions | AbortSignal | undefined,
): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof (value as AbortSignal).addEventListener === 'function'
  );
}

function makeAbortError(): Error {
  const err = new Error('请求已被取消');
  err.name = 'AbortError';
  return err;
}

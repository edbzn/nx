import { availableParallelism, cpus, freemem, totalmem } from 'node:os';

export interface ResourceSample {
  /** Busy fraction of all CPUs since the previous sample, 0..1. */
  cpuUsage: number;
  /** Available fraction of the memory this process may use, 0..1. */
  memoryAvailable: number;
}

export interface DynamicParallelismOptions {
  min?: number;
  max?: number;
  initial?: number;
  intervalMs?: number;
  /** Shrink by one slot above this CPU usage. */
  cpuHigh?: number;
  /** Grow by one slot below this CPU usage. */
  cpuLow?: number;
  /** Halve the slots below this available memory. */
  memoryCritical?: number;
  /** Do not grow below this available memory. */
  memoryLow?: number;
  sample?: () => ResourceSample;
}

export function maxAutoParallelism(): number {
  return Math.max(1, availableParallelism?.() ?? cpus().length);
}

/**
 * Slot count behind `--parallel=auto`: halved under memory pressure, one less
 * on saturated CPUs, one more on headroom with every slot taken. Shrinking
 * never kills a running task, it only holds back dispatch.
 */
export class DynamicParallelism {
  readonly min: number;
  readonly max: number;
  private current: number;
  private timer: NodeJS.Timeout | undefined;
  private readonly opts: Required<
    Omit<DynamicParallelismOptions, 'min' | 'max' | 'initial'>
  >;

  constructor(
    options: DynamicParallelismOptions = {},
    private readonly onChange: (
      limit: number,
      reason: string
    ) => void = () => {}
  ) {
    this.max = Math.max(1, options.max ?? maxAutoParallelism());
    this.min = Math.min(this.max, Math.max(1, options.min ?? 1));
    this.current = clamp(
      options.initial ?? Math.ceil(this.max / 2),
      this.min,
      this.max
    );
    this.opts = {
      intervalMs: options.intervalMs ?? 1000,
      cpuHigh: options.cpuHigh ?? 0.9,
      cpuLow: options.cpuLow ?? 0.75,
      memoryCritical: options.memoryCritical ?? 0.1,
      memoryLow: options.memoryLow ?? 0.2,
      sample: options.sample ?? createResourceSampler(),
    };
  }

  get limit(): number {
    return this.current;
  }

  start(getRunning: () => number) {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.adjust(this.opts.sample(), getRunning()),
      this.opts.intervalMs
    );
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  adjust({ cpuUsage, memoryAvailable }: ResourceSample, running: number) {
    const { cpuHigh, cpuLow, memoryCritical, memoryLow } = this.opts;
    let next = this.current;
    let reason: string;

    if (memoryAvailable < memoryCritical) {
      next = Math.floor(this.current / 2);
      reason = `memory available ${pct(memoryAvailable)}`;
    } else if (cpuUsage > cpuHigh) {
      next = this.current - 1;
      reason = `cpu ${pct(cpuUsage)}`;
    } else if (
      cpuUsage < cpuLow &&
      memoryAvailable > memoryLow &&
      running >= this.current
    ) {
      next = this.current + 1;
      reason = `cpu ${pct(cpuUsage)}, memory available ${pct(memoryAvailable)}`;
    }

    next = clamp(next, this.min, this.max);
    if (next !== this.current) {
      this.current = next;
      this.onChange(next, reason);
    }
    return next;
  }
}

// Memory honours the cgroup limit, so a CI container is judged against its own budget.
export function createResourceSampler(): () => ResourceSample {
  let previous = cpuTimes();
  return () => {
    const now = cpuTimes();
    const total = now.total - previous.total;
    const idle = now.idle - previous.idle;
    previous = now;
    return {
      cpuUsage: total > 0 ? 1 - idle / total : 0,
      memoryAvailable: memoryAvailable(),
    };
  };
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

function memoryAvailable(): number {
  const constrained = process.constrainedMemory?.();
  const available = process.availableMemory?.();
  if (constrained && available !== undefined && constrained < totalmem()) {
    return available / constrained;
  }
  return freemem() / totalmem();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pct(fraction: number) {
  return `${Math.round(fraction * 100)}%`;
}

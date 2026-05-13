export const GRAPH_PERF_METRICS = {
  threeRafTick: 'three.raf.tick',
  threeSceneUpdate: 'three.scene.update',
  threePointerPick: 'three.pointer.pick',
  threeDprChange: 'three.dpr.change',
  sigmaRefresh: 'sigma.refresh',
  graphAdapterConversion: 'graph.adapter.conversion',
} as const;

export type GraphPerfMetric = (typeof GRAPH_PERF_METRICS)[keyof typeof GRAPH_PERF_METRICS];

export interface GraphPerfRecordOptions {
  label?: string;
  durationMs?: number;
  count?: number;
}

export interface GraphPerfEntry extends GraphPerfRecordOptions {
  metric: GraphPerfMetric;
}

export interface GraphPerfObserver {
  readonly enabled: boolean;
  readonly now?: () => number;
  record: (entry: GraphPerfEntry) => void;
}

export interface GraphPerfCounterSnapshot {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs?: number;
}

export interface GraphPerfMetricSnapshot extends GraphPerfCounterSnapshot {
  labels: Record<string, GraphPerfCounterSnapshot>;
}

export type GraphPerfSnapshot = Partial<Record<GraphPerfMetric, GraphPerfMetricSnapshot>>;

export interface GraphPerfCollector extends GraphPerfObserver {
  setEnabled: (enabled: boolean) => void;
  reset: () => void;
  snapshot: () => GraphPerfSnapshot;
}

export interface GraphPerfCollectorOptions {
  enabled?: boolean;
  now?: () => number;
}

type MutableCounter = GraphPerfCounterSnapshot & {
  labels: Map<string, MutableCounter>;
};

const createCounter = (): MutableCounter => ({
  count: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
  labels: new Map(),
});

const readNow = (observer?: GraphPerfObserver): number => {
  if (observer?.now) return observer.now();
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

const applyEntry = (counter: MutableCounter, count: number, durationMs?: number): void => {
  counter.count += count;
  if (durationMs === undefined) return;

  counter.totalDurationMs += durationMs;
  counter.maxDurationMs = Math.max(counter.maxDurationMs, durationMs);
  counter.lastDurationMs = durationMs;
};

const snapshotCounter = (counter: MutableCounter): GraphPerfMetricSnapshot => ({
  count: counter.count,
  totalDurationMs: counter.totalDurationMs,
  maxDurationMs: counter.maxDurationMs,
  ...(counter.lastDurationMs === undefined ? {} : { lastDurationMs: counter.lastDurationMs }),
  labels: Object.fromEntries(
    Array.from(counter.labels.entries()).map(([label, labelCounter]) => [
      label,
      {
        count: labelCounter.count,
        totalDurationMs: labelCounter.totalDurationMs,
        maxDurationMs: labelCounter.maxDurationMs,
        ...(labelCounter.lastDurationMs === undefined
          ? {}
          : { lastDurationMs: labelCounter.lastDurationMs }),
      },
    ]),
  ),
});

export const createGraphPerfCollector = (
  options: GraphPerfCollectorOptions = {},
): GraphPerfCollector => {
  let enabled = options.enabled ?? false;
  const now = options.now;
  const counters = new Map<GraphPerfMetric, MutableCounter>();

  const getCounter = (metric: GraphPerfMetric): MutableCounter => {
    let counter = counters.get(metric);
    if (!counter) {
      counter = createCounter();
      counters.set(metric, counter);
    }
    return counter;
  };

  return {
    get enabled() {
      return enabled;
    },
    now,
    setEnabled(nextEnabled) {
      enabled = nextEnabled;
    },
    record(entry) {
      if (!enabled) return;

      const count = entry.count ?? 1;
      if (count <= 0) return;

      const counter = getCounter(entry.metric);
      applyEntry(counter, count, entry.durationMs);

      if (entry.label) {
        let labelCounter = counter.labels.get(entry.label);
        if (!labelCounter) {
          labelCounter = createCounter();
          counter.labels.set(entry.label, labelCounter);
        }
        applyEntry(labelCounter, count, entry.durationMs);
      }
    },
    reset() {
      counters.clear();
    },
    snapshot() {
      return Object.fromEntries(
        Array.from(counters.entries()).map(([metric, counter]) => [
          metric,
          snapshotCounter(counter),
        ]),
      ) as GraphPerfSnapshot;
    },
  };
};

export const recordGraphPerf = (
  observer: GraphPerfObserver | undefined,
  metric: GraphPerfMetric,
  options: GraphPerfRecordOptions = {},
): void => {
  if (!observer?.enabled) return;
  observer.record({ metric, ...options });
};

export const startGraphPerfMeasure = (
  observer: GraphPerfObserver | undefined,
  metric: GraphPerfMetric,
  options: Omit<GraphPerfRecordOptions, 'durationMs' | 'count'> = {},
): (() => void) => {
  if (!observer?.enabled) return () => {};

  const startedAt = readNow(observer);
  let recorded = false;

  return () => {
    if (recorded) return;
    recorded = true;
    recordGraphPerf(observer, metric, {
      ...options,
      durationMs: Math.max(0, readNow(observer) - startedAt),
    });
  };
};

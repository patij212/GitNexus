import { describe, expect, it } from 'vitest';
import { knowledgeGraphToGraphology } from '../../src/lib/graph-adapter';
import {
  GRAPH_PERF_METRICS,
  createGraphPerfCollector,
  recordGraphPerf,
  startGraphPerfMeasure,
  type GraphPerfMetric,
} from '../../src/lib/graph-perf';
import { createDeterministicKnowledgeGraphFixture } from '../fixtures/graph';

describe('graph perf instrumentation', () => {
  it('is disabled by default', () => {
    const collector = createGraphPerfCollector();
    const finishMeasure = startGraphPerfMeasure(
      collector,
      GRAPH_PERF_METRICS.graphAdapterConversion,
      { label: 'adapter' },
    );

    recordGraphPerf(collector, GRAPH_PERF_METRICS.threeRafTick);
    finishMeasure();

    expect(collector.enabled).toBe(false);
    expect(collector.snapshot()).toEqual({});
  });

  it('records expected counters and labels when enabled', () => {
    let now = 100;
    const collector = createGraphPerfCollector({
      enabled: true,
      now: () => now,
    });
    const metrics: GraphPerfMetric[] = [
      GRAPH_PERF_METRICS.threeRafTick,
      GRAPH_PERF_METRICS.threePointerPick,
      GRAPH_PERF_METRICS.sigmaRefresh,
    ];

    metrics.forEach((metric) => recordGraphPerf(collector, metric, { label: 'pressure' }));

    const finishSceneUpdate = startGraphPerfMeasure(
      collector,
      GRAPH_PERF_METRICS.threeSceneUpdate,
      { label: 'frame' },
    );
    now = 112.5;
    finishSceneUpdate();

    const snapshot = collector.snapshot();
    expect(snapshot[GRAPH_PERF_METRICS.threeRafTick]?.count).toBe(1);
    expect(snapshot[GRAPH_PERF_METRICS.threePointerPick]?.labels.pressure.count).toBe(1);
    expect(snapshot[GRAPH_PERF_METRICS.sigmaRefresh]?.labels.pressure.count).toBe(1);
    expect(snapshot[GRAPH_PERF_METRICS.threeSceneUpdate]?.count).toBe(1);
    expect(snapshot[GRAPH_PERF_METRICS.threeSceneUpdate]?.totalDurationMs).toBe(12.5);
    expect(snapshot[GRAPH_PERF_METRICS.threeSceneUpdate]?.labels.frame.lastDurationMs).toBe(12.5);
  });

  it('records graph adapter conversion duration for deterministic fixtures', () => {
    let now = 0;
    const collector = createGraphPerfCollector({
      enabled: true,
      now: () => {
        now += 4;
        return now;
      },
    });
    const graph = createDeterministicKnowledgeGraphFixture({
      fileCount: 2,
      functionsPerFile: 3,
    });

    const renderGraph = knowledgeGraphToGraphology(graph, undefined, {
      perfObserver: collector,
      perfLabel: 'fixture',
    });

    const conversion = collector.snapshot()[GRAPH_PERF_METRICS.graphAdapterConversion];
    expect(renderGraph.order).toBe(8);
    expect(renderGraph.size).toBe(11);
    expect(conversion?.count).toBe(1);
    expect(conversion?.totalDurationMs).toBe(4);
    expect(conversion?.labels.fixture.count).toBe(1);
  });

  it('builds deterministic graph fixtures without randomness', () => {
    const first = createDeterministicKnowledgeGraphFixture({
      fileCount: 3,
      functionsPerFile: 2,
    });
    const second = createDeterministicKnowledgeGraphFixture({
      fileCount: 3,
      functionsPerFile: 2,
    });

    expect(first.nodes).toEqual(second.nodes);
    expect(first.relationships).toEqual(second.relationships);
  });
});

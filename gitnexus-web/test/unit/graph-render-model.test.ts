import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import {
  buildGraphRenderModel,
  colorToNumber,
  computeHotspotScore,
  createVisibilityBitset,
  graphRenderModelToGraphology,
} from '../../src/lib/graph-render-model';
import {
  createCallsRelationship,
  createContainsRelationship,
  createDeterministicKnowledgeGraphFixture,
  createFileNode,
  createFunctionNode,
} from '../fixtures/graph';

describe('computeHotspotScore', () => {
  it('is 0 when all signals are 0 and saturates to 1 when all are 1', () => {
    expect(computeHotspotScore(0, 0, 0)).toBe(0);
    expect(computeHotspotScore(1, 1, 1)).toBeCloseTo(1);
  });

  it('rewards complexity AND churn together more than either alone', () => {
    const both = computeHotspotScore(0.8, 0.8, 0);
    expect(both).toBeGreaterThan(computeHotspotScore(0.8, 0, 0));
    expect(both).toBeGreaterThan(computeHotspotScore(0, 0.8, 0));
  });

  it('keeps complex code visible even when churn data is absent', () => {
    expect(computeHotspotScore(1, 0, 0)).toBeGreaterThan(0);
  });

  it('lets impact amplify without dominating', () => {
    expect(computeHotspotScore(0.5, 0.5, 1)).toBeGreaterThan(computeHotspotScore(0.5, 0.5, 0));
    expect(computeHotspotScore(0, 0, 1)).toBeLessThan(0.2);
  });

  it('clamps out-of-range inputs into [0,1]', () => {
    expect(computeHotspotScore(2, 2, 2)).toBeLessThanOrEqual(1);
    expect(computeHotspotScore(-1, -1, -1)).toBeGreaterThanOrEqual(0);
  });
});

describe('buildGraphRenderModel', () => {
  it('is deterministic for positions, colors, endpoints, and curvature', () => {
    const graph = createDeterministicKnowledgeGraphFixture({ fileCount: 2, functionsPerFile: 2 });
    const communityMemberships = new Map<string, number>();
    graph.nodes.forEach((node, index) => {
      if (node.label === 'Function') {
        communityMemberships.set(node.id, index % 2);
      }
    });

    const first = buildGraphRenderModel(graph, communityMemberships, { colorMode: 'structure' });
    const second = buildGraphRenderModel(graph, communityMemberships, { colorMode: 'structure' });

    expect(first.nodeIds).toEqual(second.nodeIds);
    expect(first.edgeIds).toEqual(second.edgeIds);
    expect(Array.from(first.nodePositions)).toEqual(Array.from(second.nodePositions));
    expect(Array.from(first.nodeColors)).toEqual(Array.from(second.nodeColors));
    expect(Array.from(first.nodeSeeds)).toEqual(Array.from(second.nodeSeeds));
    expect(Array.from(first.edgeSourceIndices)).toEqual(Array.from(second.edgeSourceIndices));
    expect(Array.from(first.edgeTargetIndices)).toEqual(Array.from(second.edgeTargetIndices));
    expect(Array.from(first.edgeColors)).toEqual(Array.from(second.edgeColors));
    expect(Array.from(first.edgeSeeds)).toEqual(Array.from(second.edgeSeeds));
    expect(Array.from(first.edgeCurvatureSeeds)).toEqual(Array.from(second.edgeCurvatureSeeds));
    expect(Array.from(first.edgeCurvatures)).toEqual(Array.from(second.edgeCurvatures));
    expect(Array.from(first.edgeCurveMultipliers)).toEqual(Array.from(second.edgeCurveMultipliers));
  });

  it('layered depthMode places nodes on architectural strata; organic leaves Z unset', () => {
    const graph = createDeterministicKnowledgeGraphFixture({ fileCount: 2, functionsPerFile: 3 });

    // Default (organic): the 3D Z stays a hook-free hash scatter — no semantic Z.
    const organic = buildGraphRenderModel(graph);
    organic.nodes.forEach((node) => {
      expect(node.attributes.z).toBeUndefined();
      expect(node.attributes.depthZ).toBeUndefined();
    });

    // Layered: every node gets a concrete Z and a stratum force-target.
    const layered = buildGraphRenderModel(graph, undefined, { depthMode: 'layered' });
    layered.nodes.forEach((node) => {
      expect(typeof node.attributes.z).toBe('number');
      expect(typeof node.attributes.depthZ).toBe('number');
    });

    // Files sit in front of (greater Z than) the functions they contain, and all
    // nodes of one kind share a single stratum target (jitter only moves `z`).
    const fileDepth = layered.nodes.find((n) => n.attributes.nodeType === 'File')!.attributes
      .depthZ!;
    const fnNodes = layered.nodes.filter((n) => n.attributes.nodeType === 'Function');
    const fnDepth = fnNodes[0]!.attributes.depthZ!;
    expect(fileDepth).toBeGreaterThan(fnDepth);
    fnNodes.forEach((n) => expect(n.attributes.depthZ).toBeCloseTo(fnDepth));
  });

  it('hotspot colorMode yields deterministic risk colours for every node', () => {
    const graph = createDeterministicKnowledgeGraphFixture({ fileCount: 2, functionsPerFile: 2 });
    const a = buildGraphRenderModel(graph, undefined, { colorMode: 'hotspot' });
    const b = buildGraphRenderModel(graph, undefined, { colorMode: 'hotspot' });
    expect(Array.from(a.nodeColors)).toEqual(Array.from(b.nodeColors));
    a.nodes.forEach((node) => expect(node.attributes.color).toMatch(/^#[0-9a-f]{6}$/i));
  });

  it('round-trips stable model indexes, colors, and curvature into graphology attrs', () => {
    const graph = createDeterministicKnowledgeGraphFixture({ fileCount: 2, functionsPerFile: 2 });
    const model = buildGraphRenderModel(graph);
    const renderGraph = graphRenderModelToGraphology(model);

    model.nodes.forEach((node, index) => {
      const attrs = renderGraph.getNodeAttributes(node.id);

      expect(node.index).toBe(index);
      expect(model.nodeIdToIndex.get(node.id)).toBe(index);
      expect(attrs.x).toBe(node.attributes.x);
      expect(attrs.y).toBe(node.attributes.y);
      expect(attrs.color).toBe(node.attributes.color);
      expect(colorToNumber(attrs.color)).toBe(model.nodeColors[index]);
    });

    model.edges.forEach((edge, index) => {
      const attrs = renderGraph.getEdgeAttributes(edge.id);

      expect(edge.index).toBe(index);
      expect(model.edgeIdToIndex.get(edge.id)).toBe(index);
      expect(renderGraph.extremities(edge.id)).toEqual([edge.sourceId, edge.targetId]);
      expect(attrs.curvature).toBe(edge.attributes.curvature);
      expect(attrs.color).toBe(edge.attributes.color);
      expect(colorToNumber(attrs.color)).toBe(model.edgeColors[index]);
    });
  });

  it('exposes stable ids, id indexes, typed array lengths, and numeric colors', () => {
    const graph = createDeterministicKnowledgeGraphFixture({ fileCount: 2, functionsPerFile: 2 });
    const model = buildGraphRenderModel(graph);

    expect(model.nodeCount).toBe(graph.nodes.length);
    expect(model.edgeCount).toBe(graph.relationships.length);
    expect(model.nodePositions).toHaveLength(model.nodeCount * 3);
    expect(model.nodeColors).toHaveLength(model.nodeCount);
    expect(model.nodeSeeds).toHaveLength(model.nodeCount);
    expect(model.edgeSourceIndices).toHaveLength(model.edgeCount);
    expect(model.edgeTargetIndices).toHaveLength(model.edgeCount);
    expect(model.edgeColors).toHaveLength(model.edgeCount);
    expect(model.edgeCurvatureSeeds).toHaveLength(model.edgeCount);
    expect(model.edgeCurvatures).toHaveLength(model.edgeCount);
    expect(model.nodeVisibilityBits).toHaveLength(Math.ceil(model.nodeCount / 32));
    expect(model.edgeVisibilityBits).toHaveLength(Math.ceil(model.edgeCount / 32));

    graph.nodes.forEach((node, index) => {
      expect(model.nodeIds[index]).toBe(node.id);
      expect(model.nodeIdToIndex.get(node.id)).toBe(index);
      expect(model.nodeColors[index]).toBe(colorToNumber(model.nodes[index].attributes.color));
      expect(model.nodeVisibility[index]).toBe(1);
    });

    model.edges.forEach((edge, index) => {
      expect(model.edgeIds[index]).toBe(edge.id);
      expect(model.edgeIdToIndex.get(edge.id)).toBe(index);
      expect(model.edgeSourceIndices[index]).toBe(model.nodeIdToIndex.get(edge.sourceId));
      expect(model.edgeTargetIndices[index]).toBe(model.nodeIdToIndex.get(edge.targetId));
      expect(model.edgeColors[index]).toBe(colorToNumber(edge.attributes.color));
      expect(model.edgeVisibility[index]).toBe(1);
    });
  });

  it('records edge endpoint indices for parallel relationships', () => {
    const graph = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const main = createFunctionNode('main', 'src/app.ts', 1);
    const helper = createFunctionNode('helper', 'src/app.ts', 20);

    graph.addNode(file);
    graph.addNode(main);
    graph.addNode(helper);
    graph.addRelationship(createContainsRelationship(file.id, main.id));
    graph.addRelationship(createContainsRelationship(file.id, helper.id));
    graph.addRelationship(createCallsRelationship(main.id, helper.id));
    graph.addRelationship({
      id: 'main-decorates-helper',
      sourceId: main.id,
      targetId: helper.id,
      type: 'DECORATES',
      confidence: 0.7,
      reason: 'metadata',
    });

    const model = buildGraphRenderModel(graph);
    const parallelEdges = model.edges.filter(
      (edge) => edge.sourceId === main.id && edge.targetId === helper.id,
    );

    expect(parallelEdges).toHaveLength(2);
    parallelEdges.forEach((edge) => {
      expect(edge.sourceIndex).toBe(model.nodeIdToIndex.get(main.id));
      expect(edge.targetIndex).toBe(model.nodeIdToIndex.get(helper.id));
      expect(model.edgeSourceIndices[edge.index]).toBe(edge.sourceIndex);
      expect(model.edgeTargetIndices[edge.index]).toBe(edge.targetIndex);
      expect(edge.attributes.curvature).toBeGreaterThanOrEqual(0.12);
      expect(edge.attributes.curvature).toBeLessThanOrEqual(0.2);
    });
  });

  it('creates packed visibility bitsets without changing filter semantics', () => {
    const visibility = new Uint8Array([1, 0, 1, 1, 0, 1]);

    expect(Array.from(createVisibilityBitset(visibility))).toEqual([45]);
  });
});

import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import {
  buildGraphRenderModel,
  colorToNumber,
  createVisibilityBitset,
} from '../../src/lib/graph-render-model';
import {
  createCallsRelationship,
  createContainsRelationship,
  createDeterministicKnowledgeGraphFixture,
  createFileNode,
  createFunctionNode,
} from '../fixtures/graph';

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
    expect(Array.from(first.edgeSourceIndices)).toEqual(Array.from(second.edgeSourceIndices));
    expect(Array.from(first.edgeTargetIndices)).toEqual(Array.from(second.edgeTargetIndices));
    expect(Array.from(first.edgeCurvatures)).toEqual(Array.from(second.edgeCurvatures));
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

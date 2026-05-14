import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import {
  applyGraphVisibilityFilter,
  computeGraphVisibilitySnapshot,
  filterGraphByDepth,
  knowledgeGraphToGraphology,
} from '../../src/lib/graph-adapter';
import {
  buildGraphRenderModel,
  graphRenderModelToGraphology,
} from '../../src/lib/graph-render-model';
import {
  createCallsRelationship,
  createClassNode,
  createContainsRelationship,
  createFileNode,
  createFunctionNode,
} from '../fixtures/graph';

const createVisibilityFixture = () => {
  const graph = createKnowledgeGraph();
  const file = createFileNode('app.ts', 'src/app.ts');
  const main = createFunctionNode('main', 'src/app.ts', 1);
  const helper = createFunctionNode('helper', 'src/app.ts', 20);
  const service = createClassNode('Service', 'src/app.ts');

  graph.addNode(file);
  graph.addNode(main);
  graph.addNode(helper);
  graph.addNode(service);
  graph.addRelationship(createContainsRelationship(file.id, main.id));
  graph.addRelationship(createCallsRelationship(main.id, helper.id));
  graph.addRelationship(createCallsRelationship(helper.id, service.id));

  return { file, main, helper, service, renderGraph: knowledgeGraphToGraphology(graph) };
};

const nodeVisibility = (
  snapshot: ReturnType<typeof computeGraphVisibilitySnapshot>,
  nodeId: string,
): number => snapshot.nodeVisibility[snapshot.nodeIds.indexOf(nodeId)];

const nodeVisibilityBit = (
  snapshot: ReturnType<typeof computeGraphVisibilitySnapshot>,
  nodeId: string,
): boolean => {
  const index = snapshot.nodeIds.indexOf(nodeId);
  return (snapshot.nodeVisibilityBits[index >> 5] & (2 ** (index & 31))) !== 0;
};

const edgeVisibility = (
  snapshot: ReturnType<typeof computeGraphVisibilitySnapshot>,
  edgeId: string,
): number => snapshot.edgeVisibility[snapshot.edgeIds.indexOf(edgeId)];

const edgeVisibilityBit = (
  snapshot: ReturnType<typeof computeGraphVisibilitySnapshot>,
  edgeId: string,
): boolean => {
  const index = snapshot.edgeIds.indexOf(edgeId);
  return (snapshot.edgeVisibilityBits[index >> 5] & (2 ** (index & 31))) !== 0;
};

describe('knowledgeGraphToGraphology', () => {
  it('preserves parallel relationships between the same source and target', () => {
    const graph = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const fn = createFunctionNode('main', 'src/app.ts', 1);

    graph.addNode(file);
    graph.addNode(fn);
    graph.addRelationship({
      id: 'defines-main',
      sourceId: file.id,
      targetId: fn.id,
      type: 'DEFINES',
      confidence: 1,
      reason: 'file owns symbol',
    });
    graph.addRelationship({
      id: 'decorates-main',
      sourceId: file.id,
      targetId: fn.id,
      type: 'DECORATES',
      confidence: 0.8,
      reason: 'annotation metadata',
    });

    const renderGraph = knowledgeGraphToGraphology(graph);
    const relationTypes: string[] = [];
    renderGraph.forEachEdge((_edgeId, attributes) => {
      relationTypes.push(attributes.relationType);
    });

    expect(relationTypes.sort()).toEqual(['DECORATES', 'DEFINES']);
  });

  it('converts from the render model without changing parallel edge attributes', () => {
    const graph = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const fn = createFunctionNode('main', 'src/app.ts', 1);

    graph.addNode(file);
    graph.addNode(fn);
    graph.addRelationship({
      id: 'defines-main',
      sourceId: file.id,
      targetId: fn.id,
      type: 'DEFINES',
      confidence: 1,
      reason: 'file owns symbol',
    });
    graph.addRelationship({
      id: 'decorates-main',
      sourceId: file.id,
      targetId: fn.id,
      type: 'DECORATES',
      confidence: 0.8,
      reason: 'annotation metadata',
    });

    const renderModel = buildGraphRenderModel(graph);
    const adapterGraph = knowledgeGraphToGraphology(graph);
    const modelGraph = graphRenderModelToGraphology(renderModel);

    expect(adapterGraph.order).toBe(modelGraph.order);
    expect(adapterGraph.size).toBe(modelGraph.size);
    expect(adapterGraph.edges().sort()).toEqual(modelGraph.edges().sort());

    adapterGraph.forEachEdge((edgeId, attributes, sourceId, targetId) => {
      expect(modelGraph.extremities(edgeId)).toEqual([sourceId, targetId]);
      expect(modelGraph.getEdgeAttributes(edgeId)).toEqual(attributes);
    });
  });

  it('does not use Math.random for production graph positions or curvature', () => {
    const graph = createKnowledgeGraph();
    const file = createFileNode('app.ts', 'src/app.ts');
    const fn = createFunctionNode('main', 'src/app.ts', 1);
    graph.addNode(file);
    graph.addNode(fn);
    graph.addRelationship({
      id: 'defines-main',
      sourceId: file.id,
      targetId: fn.id,
      type: 'DEFINES',
      confidence: 1,
      reason: 'file owns symbol',
    });

    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random should not be used during graph conversion');
    });

    try {
      expect(() => knowledgeGraphToGraphology(graph)).not.toThrow();
    } finally {
      randomSpy.mockRestore();
    }
  });
});

describe('graph visibility snapshots', () => {
  it('computes node visibility bitsets without applying graphology hidden attrs', () => {
    const { file, main, helper, service, renderGraph } = createVisibilityFixture();
    const snapshot = computeGraphVisibilitySnapshot(renderGraph, {
      selectedNodeId: null,
      maxHops: null,
      visibleLabels: ['File', 'Function'],
    });

    expect(nodeVisibility(snapshot, file.id)).toBe(1);
    expect(nodeVisibility(snapshot, main.id)).toBe(1);
    expect(nodeVisibility(snapshot, helper.id)).toBe(1);
    expect(nodeVisibility(snapshot, service.id)).toBe(0);
    expect(nodeVisibilityBit(snapshot, file.id)).toBe(true);
    expect(nodeVisibilityBit(snapshot, helper.id)).toBe(true);
    expect(nodeVisibilityBit(snapshot, service.id)).toBe(false);
    expect(snapshot.visibleNodeCount).toBe(3);
    expect(renderGraph.getNodeAttribute(service.id, 'hidden')).toBe(false);
  });

  it('combines depth filtering, label filtering, and edge endpoint visibility', () => {
    const { file, main, helper, service, renderGraph } = createVisibilityFixture();
    const helperToServiceEdge = renderGraph.edges().find((edgeId) => {
      const [sourceId, targetId] = renderGraph.extremities(edgeId);
      return sourceId === helper.id && targetId === service.id;
    });

    expect(helperToServiceEdge).toBeDefined();

    const snapshot = computeGraphVisibilitySnapshot(renderGraph, {
      selectedNodeId: main.id,
      maxHops: 1,
      visibleLabels: ['File', 'Function', 'Class'],
    });

    expect(nodeVisibility(snapshot, file.id)).toBe(1);
    expect(nodeVisibility(snapshot, main.id)).toBe(1);
    expect(nodeVisibility(snapshot, helper.id)).toBe(1);
    expect(nodeVisibility(snapshot, service.id)).toBe(0);
    expect(edgeVisibility(snapshot, helperToServiceEdge!)).toBe(0);
    expect(edgeVisibilityBit(snapshot, helperToServiceEdge!)).toBe(false);
  });

  it('distinguishes no edge-type filter from an empty edge-type filter', () => {
    const { renderGraph } = createVisibilityFixture();
    const withoutEdgeTypeFilter = computeGraphVisibilitySnapshot(renderGraph, {
      selectedNodeId: null,
      maxHops: null,
      visibleLabels: ['File', 'Function', 'Class'],
    });
    const emptyEdgeTypeFilter = computeGraphVisibilitySnapshot(renderGraph, {
      selectedNodeId: null,
      maxHops: null,
      visibleLabels: ['File', 'Function', 'Class'],
      visibleEdgeTypes: [],
    });

    expect(withoutEdgeTypeFilter.visibleEdgeCount).toBe(renderGraph.size);
    expect(emptyEdgeTypeFilter.visibleEdgeCount).toBe(0);
    expect(emptyEdgeTypeFilter.generation).toBe(withoutEdgeTypeFilter.generation + 1);
  });

  it('keeps visible labels as an additional constraint inside depth results', () => {
    const { file, main, helper, service, renderGraph } = createVisibilityFixture();
    const snapshot = computeGraphVisibilitySnapshot(renderGraph, {
      selectedNodeId: main.id,
      maxHops: 1,
      visibleLabels: ['Function'],
    });

    expect(nodeVisibility(snapshot, file.id)).toBe(0);
    expect(nodeVisibility(snapshot, main.id)).toBe(1);
    expect(nodeVisibility(snapshot, helper.id)).toBe(1);
    expect(nodeVisibility(snapshot, service.id)).toBe(0);
    expect(snapshot.visibleNodeCount).toBe(2);
  });

  it('keeps generations stable for equivalent filters and advances on semantic changes', () => {
    const { renderGraph } = createVisibilityFixture();
    const first = computeGraphVisibilitySnapshot(renderGraph, {
      selectedNodeId: null,
      maxHops: null,
      visibleLabels: ['File', 'Function'],
    });
    const sameLabelsDifferentOrder = computeGraphVisibilitySnapshot(renderGraph, {
      selectedNodeId: 'ignored-when-depth-is-off',
      maxHops: null,
      visibleLabels: ['Function', 'File'],
    });
    const changed = computeGraphVisibilitySnapshot(renderGraph, {
      selectedNodeId: null,
      maxHops: null,
      visibleLabels: ['Function'],
    });

    expect(sameLabelsDifferentOrder.generation).toBe(first.generation);
    expect(sameLabelsDifferentOrder).toBe(first);
    expect(changed.generation).toBe(first.generation + 1);
  });

  it('applies graphology hidden attrs once per generation for renderer compatibility', () => {
    const { file, main, helper, service, renderGraph } = createVisibilityFixture();

    const result = applyGraphVisibilityFilter(renderGraph, {
      selectedNodeId: main.id,
      maxHops: 1,
      visibleLabels: ['Function'],
    });

    expect(result.applied).toBe(true);
    expect(renderGraph.getNodeAttribute(file.id, 'hidden')).toBe(true);
    expect(renderGraph.getNodeAttribute(main.id, 'hidden')).toBe(false);
    expect(renderGraph.getNodeAttribute(helper.id, 'hidden')).toBe(false);
    expect(renderGraph.getNodeAttribute(service.id, 'hidden')).toBe(true);

    const setNodeAttributeSpy = vi.spyOn(renderGraph, 'setNodeAttribute');
    const skipped = applyGraphVisibilityFilter(renderGraph, {
      selectedNodeId: main.id,
      maxHops: 1,
      visibleLabels: ['Function'],
    });

    expect(skipped.applied).toBe(false);
    expect(setNodeAttributeSpy).not.toHaveBeenCalled();
  });

  it('preserves filterGraphByDepth as a hidden-attr compatibility wrapper', () => {
    const { file, main, helper, service, renderGraph } = createVisibilityFixture();

    filterGraphByDepth(renderGraph, main.id, 1, ['File', 'Function', 'Class']);

    expect(renderGraph.getNodeAttribute(file.id, 'hidden')).toBe(false);
    expect(renderGraph.getNodeAttribute(main.id, 'hidden')).toBe(false);
    expect(renderGraph.getNodeAttribute(helper.id, 'hidden')).toBe(false);
    expect(renderGraph.getNodeAttribute(service.id, 'hidden')).toBe(true);
  });
});

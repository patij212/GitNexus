import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import { knowledgeGraphToGraphology } from '../../src/lib/graph-adapter';
import {
  buildGraphRenderModel,
  graphRenderModelToGraphology,
} from '../../src/lib/graph-render-model';
import { createFileNode, createFunctionNode } from '../fixtures/graph';

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

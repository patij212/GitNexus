import Graph from 'graphology';
import type { NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { type GraphColorMode } from './constants';
import { GRAPH_PERF_METRICS, startGraphPerfMeasure, type GraphPerfObserver } from './graph-perf';
import { buildGraphRenderModel, graphRenderModelToGraphology } from './graph-render-model';

export type { GraphColorMode } from './constants';

export interface SigmaNodeAttributes {
  x: number;
  y: number;
  z?: number;
  size: number;
  color: string;
  baseColor?: string;
  label: string;
  nodeType: NodeLabel;
  filePath: string;
  startLine?: number;
  endLine?: number;
  hidden?: boolean;
  zIndex?: number;
  highlighted?: boolean;
  mass?: number; // ForceAtlas2 mass - higher = more repulsion
  community?: number; // Community index from Leiden algorithm
  communityColor?: string; // Color assigned by community
  dependencyCount?: number;
  healthScore?: number;
  impactScore?: number;
  runtimeScore?: number;
  agentScore?: number;
  complexityScore?: number;
  churnScore?: number;
}

export interface SigmaEdgeAttributes {
  size: number;
  color: string;
  relationType: string;
  sourceId?: string;
  targetId?: string;
  confidence?: number;
  reason?: string;
  type?: string;
  curvature?: number;
  zIndex?: number;
}

export interface GraphologyOptions {
  colorMode?: GraphColorMode;
  impactNodeIds?: Set<string>;
  agentFocusNodeIds?: Set<string>;
  citationNodeIds?: Set<string>;
  toolNodeIds?: Set<string>;
  perfObserver?: GraphPerfObserver;
  perfLabel?: string;
}

/**
 * Converts the KnowledgeGraph to a graphology Graph for Sigma.js
 * Folders are positioned in a wide spread, children positioned NEAR their parents
 *
 * @param knowledgeGraph - The knowledge graph to convert
 * @param communityMemberships - Optional map of nodeId -> communityIndex for community coloring
 */
export const knowledgeGraphToGraphology = (
  knowledgeGraph: KnowledgeGraph,
  communityMemberships?: Map<string, number>,
  options: GraphologyOptions = {},
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> => {
  const finishConversionMeasure = startGraphPerfMeasure(
    options.perfObserver,
    GRAPH_PERF_METRICS.graphAdapterConversion,
    { label: options.perfLabel },
  );
  const renderModel = buildGraphRenderModel(knowledgeGraph, communityMemberships, options);
  const graph = graphRenderModelToGraphology(renderModel);

  finishConversionMeasure();
  return graph;
};

/**
 * Filter nodes by visibility - sets hidden attribute
 */
export const filterGraphByLabels = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  visibleLabels: NodeLabel[],
): void => {
  graph.forEachNode((nodeId, attributes) => {
    const isVisible = visibleLabels.includes(attributes.nodeType);
    graph.setNodeAttribute(nodeId, 'hidden', !isVisible);
  });
};

/**
 * Get all nodes within N hops of a starting node
 */
export const getNodesWithinHops = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  startNodeId: string,
  maxHops: number,
): Set<string> => {
  const visited = new Set<string>();
  const queue: { nodeId: string; depth: number }[] = [{ nodeId: startNodeId, depth: 0 }];

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    if (depth < maxHops) {
      graph.forEachNeighbor(nodeId, (neighborId) => {
        if (!visited.has(neighborId)) {
          queue.push({ nodeId: neighborId, depth: depth + 1 });
        }
      });
    }
  }

  return visited;
};

/**
 * Filter nodes by depth from selected node
 */
export const filterGraphByDepth = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  selectedNodeId: string | null,
  maxHops: number | null,
  visibleLabels: NodeLabel[],
): void => {
  if (maxHops === null) {
    filterGraphByLabels(graph, visibleLabels);
    return;
  }

  if (selectedNodeId === null || !graph.hasNode(selectedNodeId)) {
    filterGraphByLabels(graph, visibleLabels);
    return;
  }

  const nodesInRange = getNodesWithinHops(graph, selectedNodeId, maxHops);

  graph.forEachNode((nodeId, attributes) => {
    const isLabelVisible = visibleLabels.includes(attributes.nodeType);
    const isInRange = nodesInRange.has(nodeId);
    graph.setNodeAttribute(nodeId, 'hidden', !isLabelVisible || !isInRange);
  });
};

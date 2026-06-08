import Graph from 'graphology';
import type { NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { type GraphColorMode } from './constants';
import { GRAPH_PERF_METRICS, startGraphPerfMeasure, type GraphPerfObserver } from './graph-perf';
import {
  buildGraphRenderModel,
  createVisibilityBitset,
  graphRenderModelToGraphology,
} from './graph-render-model';

export type { GraphColorMode } from './constants';

/**
 * Z-axis layout for the 3D view. `organic` (default) scatters Z by node-id hash
 * (the original behavior). `layered` places nodes on architectural-depth strata
 * (see graph-depth.ts) so the third dimension reads as software hierarchy.
 */
export type GraphDepthMode = 'organic' | 'layered';

export interface SigmaNodeAttributes {
  x: number;
  y: number;
  z?: number;
  depthZ?: number; // layered depthMode: target Z stratum for the 3D force layout
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
  depthMode?: GraphDepthMode;
  impactNodeIds?: Set<string>;
  agentFocusNodeIds?: Set<string>;
  citationNodeIds?: Set<string>;
  toolNodeIds?: Set<string>;
  perfObserver?: GraphPerfObserver;
  perfLabel?: string;
}

export interface GraphVisibilityFilter {
  selectedNodeId: string | null;
  maxHops: number | null;
  visibleLabels: readonly NodeLabel[];
  visibleEdgeTypes?: readonly string[] | null;
}

export interface GraphVisibilitySnapshot {
  generation: number;
  signature: string;
  nodeIds: string[];
  edgeIds: string[];
  nodeVisibility: Uint8Array;
  nodeVisibilityBits: Uint32Array;
  edgeVisibility: Uint8Array;
  edgeVisibilityBits: Uint32Array;
  visibleNodeCount: number;
  visibleEdgeCount: number;
}

export interface GraphVisibilityApplyResult {
  snapshot: GraphVisibilitySnapshot;
  applied: boolean;
  changedNodeCount: number;
}

type GraphVisibilityState = {
  signature: string;
  generation: number;
  snapshot: GraphVisibilitySnapshot;
  appliedGeneration: number | null;
};

const graphVisibilityStates = new WeakMap<
  Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  GraphVisibilityState
>();

const normalizeFilterValues = (values: readonly string[]): string =>
  Array.from(new Set(values)).sort().join('\x1f');

const normalizeOptionalFilterValues = (values: readonly string[] | null | undefined): string =>
  values === null || values === undefined ? '*' : normalizeFilterValues(values);

const resolveDepthFilter = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  filter: GraphVisibilityFilter,
): { selectedNodeId: string | null; maxHops: number | null } => {
  if (filter.maxHops === null || filter.maxHops === undefined) {
    return { selectedNodeId: null, maxHops: null };
  }

  if (!filter.selectedNodeId || !graph.hasNode(filter.selectedNodeId)) {
    return { selectedNodeId: null, maxHops: null };
  }

  return { selectedNodeId: filter.selectedNodeId, maxHops: Math.max(0, filter.maxHops) };
};

const createVisibilitySignature = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  filter: GraphVisibilityFilter,
): string => {
  const depthFilter = resolveDepthFilter(graph, filter);
  const depthToken =
    depthFilter.selectedNodeId && depthFilter.maxHops !== null
      ? `${depthFilter.selectedNodeId}:${depthFilter.maxHops}`
      : 'all';

  return [
    graph.order,
    graph.size,
    depthToken,
    normalizeFilterValues(filter.visibleLabels),
    normalizeOptionalFilterValues(filter.visibleEdgeTypes),
  ].join('|');
};

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
  applyGraphVisibilityFilter(graph, {
    selectedNodeId: null,
    maxHops: null,
    visibleLabels,
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

export const computeGraphVisibilitySnapshot = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  filter: GraphVisibilityFilter,
): GraphVisibilitySnapshot => {
  const signature = createVisibilitySignature(graph, filter);
  const previousState = graphVisibilityStates.get(graph);
  if (previousState?.signature === signature) {
    return previousState.snapshot;
  }

  const generation = (previousState?.generation ?? 0) + 1;
  const depthFilter = resolveDepthFilter(graph, filter);
  const nodesInRange =
    depthFilter.selectedNodeId && depthFilter.maxHops !== null
      ? getNodesWithinHops(graph, depthFilter.selectedNodeId, depthFilter.maxHops)
      : null;
  const visibleLabelSet = new Set<NodeLabel>(filter.visibleLabels);
  const visibleEdgeTypeSet =
    filter.visibleEdgeTypes === null || filter.visibleEdgeTypes === undefined
      ? null
      : new Set<string>(filter.visibleEdgeTypes);
  const nodeIds = graph.nodes();
  const edgeIds = graph.edges();
  const nodeVisibility = new Uint8Array(nodeIds.length);
  const edgeVisibility = new Uint8Array(edgeIds.length);
  const nodeIndexById = new Map<string, number>();
  let visibleNodeCount = 0;
  let visibleEdgeCount = 0;

  nodeIds.forEach((nodeId, index) => {
    nodeIndexById.set(nodeId, index);
    const attributes = graph.getNodeAttributes(nodeId);
    const isVisibleByLabel = visibleLabelSet.has(attributes.nodeType);
    const isVisibleByDepth = !nodesInRange || nodesInRange.has(nodeId);
    if (isVisibleByLabel && isVisibleByDepth) {
      nodeVisibility[index] = 1;
      visibleNodeCount += 1;
    }
  });

  edgeIds.forEach((edgeId, index) => {
    const attributes = graph.getEdgeAttributes(edgeId);
    const [sourceId, targetId] = graph.extremities(edgeId);
    const sourceIndex = nodeIndexById.get(sourceId);
    const targetIndex = nodeIndexById.get(targetId);
    const isVisibleByType =
      !visibleEdgeTypeSet ||
      !attributes.relationType ||
      visibleEdgeTypeSet.has(attributes.relationType);
    const isVisibleByNodes =
      sourceIndex !== undefined &&
      targetIndex !== undefined &&
      nodeVisibility[sourceIndex] === 1 &&
      nodeVisibility[targetIndex] === 1;

    if (isVisibleByType && isVisibleByNodes) {
      edgeVisibility[index] = 1;
      visibleEdgeCount += 1;
    }
  });

  const snapshot: GraphVisibilitySnapshot = {
    generation,
    signature,
    nodeIds,
    edgeIds,
    nodeVisibility,
    nodeVisibilityBits: createVisibilityBitset(nodeVisibility),
    edgeVisibility,
    edgeVisibilityBits: createVisibilityBitset(edgeVisibility),
    visibleNodeCount,
    visibleEdgeCount,
  };

  graphVisibilityStates.set(graph, {
    signature,
    generation,
    snapshot,
    appliedGeneration: previousState?.appliedGeneration ?? null,
  });

  return snapshot;
};

export const applyGraphVisibilitySnapshot = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  snapshot: GraphVisibilitySnapshot,
  options: { force?: boolean } = {},
): GraphVisibilityApplyResult => {
  const previousState = graphVisibilityStates.get(graph);
  if (
    !options.force &&
    previousState?.signature === snapshot.signature &&
    previousState.appliedGeneration === snapshot.generation
  ) {
    return { snapshot, applied: false, changedNodeCount: 0 };
  }

  let changedNodeCount = 0;
  snapshot.nodeIds.forEach((nodeId, index) => {
    if (!graph.hasNode(nodeId)) return;

    const nextHidden = snapshot.nodeVisibility[index] === 0;
    const currentHidden = Boolean(graph.getNodeAttribute(nodeId, 'hidden'));
    if (currentHidden === nextHidden) return;

    graph.setNodeAttribute(nodeId, 'hidden', nextHidden);
    changedNodeCount += 1;
  });

  graphVisibilityStates.set(graph, {
    signature: snapshot.signature,
    generation: snapshot.generation,
    snapshot,
    appliedGeneration: snapshot.generation,
  });

  return { snapshot, applied: true, changedNodeCount };
};

export const applyGraphVisibilityFilter = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  filter: GraphVisibilityFilter,
  options: { force?: boolean } = {},
): GraphVisibilityApplyResult =>
  applyGraphVisibilitySnapshot(graph, computeGraphVisibilitySnapshot(graph, filter), options);

/**
 * Filter nodes by depth from selected node
 */
export const filterGraphByDepth = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  selectedNodeId: string | null,
  maxHops: number | null,
  visibleLabels: NodeLabel[],
): void => {
  applyGraphVisibilityFilter(graph, {
    selectedNodeId,
    maxHops,
    visibleLabels,
  });
};

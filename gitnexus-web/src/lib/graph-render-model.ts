import Graph from 'graphology';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import {
  NODE_SIZES,
  getAgentColor,
  getCommunityColor,
  getEdgeStyle,
  getMetricColor,
  getNodeTypeColor,
  type GraphColorMode,
} from './constants';
import type { GraphologyOptions, SigmaEdgeAttributes, SigmaNodeAttributes } from './graph-adapter';
import { depthLevelToZ, depthStratumGap, getNodeDepthLevel } from './graph-depth';

export interface GraphRenderNode {
  id: string;
  index: number;
  seed: number;
  attributes: SigmaNodeAttributes;
}

export interface GraphRenderEdge {
  id: string;
  index: number;
  sourceId: string;
  targetId: string;
  sourceIndex: number;
  targetIndex: number;
  seed: number;
  curvatureSeed: number;
  attributes: SigmaEdgeAttributes;
}

export interface GraphRenderModel {
  nodeCount: number;
  edgeCount: number;
  nodeIds: string[];
  edgeIds: string[];
  nodeIdToIndex: Map<string, number>;
  edgeIdToIndex: Map<string, number>;
  nodes: GraphRenderNode[];
  edges: GraphRenderEdge[];
  nodePositions: Float32Array;
  nodeColors: Uint32Array;
  nodeSeeds: Uint32Array;
  nodeVisibility: Uint8Array;
  nodeVisibilityBits: Uint32Array;
  edgeSourceIndices: Uint32Array;
  edgeTargetIndices: Uint32Array;
  edgeColors: Uint32Array;
  edgeSeeds: Uint32Array;
  edgeCurvatureSeeds: Float32Array;
  edgeCurvatures: Float32Array;
  edgeCurveMultipliers: Float32Array;
  edgeVisibility: Uint8Array;
  edgeVisibilityBits: Uint32Array;
}

const STRUCTURAL_TYPES = new Set<NodeLabel>(['Project', 'Package', 'Module', 'Folder']);
const SYMBOL_TYPES = new Set<NodeLabel>(['Function', 'Class', 'Method', 'Interface']);
const HIERARCHY_RELATIONS = new Set(['CONTAINS', 'DEFINES', 'IMPORTS']);
const IGNORED_HEALTH_RELATIONSHIPS = new Set(['MEMBER_OF', 'STEP_IN_PROCESS', 'ENTRY_POINT_OF']);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export const hashStringToUint32 = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const hashToUnit = (value: string): number => hashStringToUint32(value) / 0xffffffff;

const centeredUnit = (value: string): number => hashToUnit(value) - 0.5;

export const colorToNumber = (color: string): number => {
  const normalized = color.trim();
  const hex = normalized.startsWith('#') ? normalized.slice(1) : normalized;

  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const expanded = hex
      .split('')
      .map((part) => `${part}${part}`)
      .join('');
    return parseInt(expanded, 16);
  }

  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return parseInt(hex, 16);
  }

  return 0;
};

export const createVisibilityBitset = (visibility: Uint8Array): Uint32Array => {
  const words = new Uint32Array(Math.ceil(visibility.length / 32));
  visibility.forEach((isVisible, index) => {
    if (!isVisible) return;
    words[index >> 5] |= 2 ** (index & 31);
  });
  return words;
};

/**
 * Get node size scaled for graph density.
 */
const getScaledNodeSize = (baseSize: number, nodeCount: number): number => {
  if (nodeCount > 50000) return Math.max(1, baseSize * 0.4);
  if (nodeCount > 20000) return Math.max(1.5, baseSize * 0.5);
  if (nodeCount > 5000) return Math.max(2, baseSize * 0.65);
  if (nodeCount > 1000) return Math.max(2.5, baseSize * 0.8);
  return baseSize;
};

const getNodeMass = (nodeType: NodeLabel, nodeCount: number): number => {
  const baseMassMultiplier = nodeCount > 5000 ? 2 : nodeCount > 1000 ? 1.5 : 1;

  switch (nodeType) {
    case 'Project':
      return 50 * baseMassMultiplier;
    case 'Package':
      return 30 * baseMassMultiplier;
    case 'Module':
      return 20 * baseMassMultiplier;
    case 'Folder':
      return 15 * baseMassMultiplier;
    case 'File':
      return 3 * baseMassMultiplier;
    case 'Class':
    case 'Interface':
      return 5 * baseMassMultiplier;
    case 'Function':
    case 'Method':
      return 2 * baseMassMultiplier;
    default:
      return 1;
  }
};

const getDependencyScore = (degree: number, maxDegree: number): number => {
  if (maxDegree <= 0) return 0;
  return Math.log1p(degree) / Math.log1p(maxDegree);
};

const getNumberProperty = (value: unknown): number => {
  const numericValue = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
};

const getRuntimeScore = (node: GraphNode, maxErrors: number): number => {
  const explicitRate = getNumberProperty(node.properties.errorRate ?? node.properties.error_rate);
  const errorCount = getNumberProperty(
    node.properties.errorCount ?? node.properties.errors ?? node.properties.count,
  );
  const latency = getNumberProperty(
    node.properties.p95LatencyMs ?? node.properties.durationMs ?? node.properties.latencyMs,
  );
  const errorScore = maxErrors > 0 ? Math.log1p(errorCount) / Math.log1p(maxErrors) : 0;
  const latencyScore = latency > 0 ? Math.min(1, Math.log1p(latency) / Math.log1p(2500)) : 0;
  return Math.max(Math.min(1, explicitRate), errorScore, latencyScore * 0.65);
};

const getComplexityValue = (node: GraphNode): number => {
  const explicit = getNumberProperty(
    node.properties.complexity ??
      node.properties.cyclomaticComplexity ??
      node.properties.astComplexity,
  );
  if (explicit > 0) return explicit;
  const start = getNumberProperty(node.properties.startLine);
  const end = getNumberProperty(node.properties.endLine);
  return end > start ? end - start : 0;
};

const getChurnValue = (node: GraphNode): number =>
  getNumberProperty(
    node.properties.churn ??
      node.properties.churnCount ??
      node.properties.recentChanges ??
      node.properties.gitChurn,
  );

/**
 * Composite "maintenance hotspot" score in [0,1] from signals the model already
 * computes. The classic hotspot is high complexity AND high churn (a geometric
 * mean, so both must be present), amplified by impact — risky code that many
 * things depend on is worse. A complexity/impact floor keeps complex or
 * widely-depended-on code visible even when churn data is absent (e.g. a repo
 * indexed without git history).
 */
export const computeHotspotScore = (
  complexityScore: number,
  churnScore: number,
  impactScore: number,
): number => {
  const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
  const complexity = clamp01(complexityScore);
  const churn = clamp01(churnScore);
  const impact = clamp01(impactScore);
  const bothHigh = Math.sqrt(complexity * churn);
  return clamp01(0.6 * bothHigh + 0.25 * complexity + 0.15 * impact);
};

const getNodeVisual = (
  baseColor: string,
  baseSize: number,
  dependencyCount: number,
  maxDependencyCount: number,
  colorMode: GraphColorMode,
  scores: {
    impactScore?: number;
    runtimeScore?: number;
    agentScore?: number;
    complexityScore?: number;
    churnScore?: number;
  } = {},
): {
  color: string;
  size: number;
  healthScore: number;
  impactScore: number;
  runtimeScore: number;
  agentScore: number;
  complexityScore: number;
  churnScore: number;
} => {
  const healthScore = getDependencyScore(dependencyCount, maxDependencyCount);
  const impactScore = scores.impactScore ?? healthScore;
  const runtimeScore = scores.runtimeScore ?? 0;
  const agentScore = scores.agentScore ?? 0;
  const complexityScore = scores.complexityScore ?? 0;
  const churnScore = scores.churnScore ?? 0;

  if (colorMode === 'health') {
    return {
      color: getMetricColor('health', healthScore),
      size: baseSize * (1 + healthScore * 0.85),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'impact') {
    return {
      color: getMetricColor('impact', impactScore),
      size: baseSize * (1 + impactScore),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'runtime') {
    return {
      color: getMetricColor('runtime', runtimeScore),
      size: baseSize * (1 + runtimeScore),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'agent') {
    return {
      color: getAgentColor(agentScore, baseColor),
      size: baseSize * (1 + agentScore * 0.9),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'complexity') {
    return {
      color: getMetricColor('complexity', complexityScore),
      size: baseSize * (1 + complexityScore * 0.7),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'churn') {
    return {
      color: getMetricColor('churn', churnScore),
      size: baseSize * (1 + churnScore * 0.7),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  if (colorMode === 'hotspot') {
    const hotspotScore = computeHotspotScore(complexityScore, churnScore, impactScore);
    return {
      color: getMetricColor('hotspot', hotspotScore),
      size: baseSize * (1 + hotspotScore * 0.9),
      healthScore,
      impactScore,
      runtimeScore,
      agentScore,
      complexityScore,
      churnScore,
    };
  }

  return {
    color: baseColor,
    size: baseSize,
    healthScore,
    impactScore,
    runtimeScore,
    agentScore,
    complexityScore,
    churnScore,
  };
};

export const getRelationCurveMultiplier = (relationType?: string): number => {
  if (relationType === 'CONTAINS' || relationType === 'DEFINES') return 0.085;
  if (relationType === 'CALLS') return 0.24;
  if (relationType === 'IMPORTS') return 0.18;
  if (relationType === 'EXTENDS' || relationType === 'IMPLEMENTS') return 0.2;
  return 0.15;
};

const getDeterministicCurvatureSeed = (edgeKey: string): number =>
  hashToUnit(`${edgeKey}:curvature`);

const createNodeAttributes = ({
  node,
  x,
  y,
  nodeCount,
  colorMode,
  baseColor,
  dependencyCounts,
  maxDependencyCount,
  maxRuntimeErrors,
  complexityScore,
  churnScore,
  impactScore,
  agentScore,
  communityIndex,
  includeCommunityAttributes,
}: {
  node: GraphNode;
  x: number;
  y: number;
  nodeCount: number;
  colorMode: GraphColorMode;
  baseColor: string;
  dependencyCounts: Map<string, number>;
  maxDependencyCount: number;
  maxRuntimeErrors: number;
  complexityScore: number;
  churnScore: number;
  impactScore: number;
  agentScore: number;
  communityIndex?: number;
  includeCommunityAttributes: boolean;
}): SigmaNodeAttributes => {
  const baseSize = NODE_SIZES[node.label] || 8;
  const scaledSize = getScaledNodeSize(baseSize, nodeCount);
  const dependencyCount = dependencyCounts.get(node.id) ?? 0;
  const visual = getNodeVisual(
    baseColor,
    scaledSize,
    dependencyCount,
    maxDependencyCount,
    colorMode,
    {
      impactScore,
      runtimeScore: getRuntimeScore(node, maxRuntimeErrors),
      agentScore,
      complexityScore,
      churnScore,
    },
  );
  const attributes: SigmaNodeAttributes = {
    x,
    y,
    size: visual.size,
    color: visual.color,
    baseColor,
    label: node.properties.name,
    nodeType: node.label,
    filePath: node.properties.filePath,
    startLine: node.properties.startLine,
    endLine: node.properties.endLine,
    hidden: false,
    mass: getNodeMass(node.label, nodeCount),
    dependencyCount,
    healthScore: visual.healthScore,
    impactScore: visual.impactScore,
    runtimeScore: visual.runtimeScore,
    agentScore: visual.agentScore,
    complexityScore: visual.complexityScore,
    churnScore: visual.churnScore,
  };

  if (includeCommunityAttributes) {
    attributes.community = communityIndex;
    attributes.communityColor =
      communityIndex === undefined ? undefined : getCommunityColor(communityIndex);
  }

  return attributes;
};

export const buildGraphRenderModel = (
  knowledgeGraph: KnowledgeGraph,
  communityMemberships?: Map<string, number>,
  options: GraphologyOptions = {},
): GraphRenderModel => {
  const nodeCount = knowledgeGraph.nodes.length;
  const colorMode = options.colorMode ?? 'type';
  const depthMode = options.depthMode ?? 'organic';
  const dependencyCounts = new Map<string, number>();

  knowledgeGraph.relationships.forEach((relationship) => {
    if (IGNORED_HEALTH_RELATIONSHIPS.has(relationship.type)) return;
    dependencyCounts.set(
      relationship.sourceId,
      (dependencyCounts.get(relationship.sourceId) ?? 0) + 1,
    );
    dependencyCounts.set(
      relationship.targetId,
      (dependencyCounts.get(relationship.targetId) ?? 0) + 1,
    );
  });
  const maxDependencyCount = Math.max(0, ...dependencyCounts.values());
  const maxRuntimeErrors = Math.max(
    0,
    ...knowledgeGraph.nodes.map((node) =>
      getNumberProperty(
        node.properties.errorCount ?? node.properties.errors ?? node.properties.count,
      ),
    ),
  );
  const complexityValues = new Map<string, number>();
  const churnValues = new Map<string, number>();
  knowledgeGraph.nodes.forEach((node) => {
    complexityValues.set(node.id, getComplexityValue(node));
    churnValues.set(node.id, getChurnValue(node));
  });
  const maxComplexity = Math.max(0, ...complexityValues.values());
  const maxChurn = Math.max(0, ...churnValues.values());
  const scoreByMax = (value: number, maxValue: number): number =>
    maxValue > 0 ? Math.log1p(value) / Math.log1p(maxValue) : 0;
  const getAgentScore = (nodeId: string): number => {
    if (options.toolNodeIds?.has(nodeId)) return 1;
    if (options.citationNodeIds?.has(nodeId)) return 0.72;
    if (options.agentFocusNodeIds?.has(nodeId)) return 0.55;
    return 0;
  };
  const getImpactScore = (nodeId: string, dependencyCount: number): number =>
    options.impactNodeIds?.has(nodeId)
      ? 1
      : getDependencyScore(dependencyCount, maxDependencyCount) * 0.55;

  const parentToChildren = new Map<string, string[]>();
  const childToParent = new Map<string, string>();
  knowledgeGraph.relationships.forEach((relationship) => {
    if (!HIERARCHY_RELATIONS.has(relationship.type)) return;
    if (!parentToChildren.has(relationship.sourceId)) {
      parentToChildren.set(relationship.sourceId, []);
    }
    parentToChildren.get(relationship.sourceId)!.push(relationship.targetId);
    childToParent.set(relationship.targetId, relationship.sourceId);
  });

  const nodeMap = new Map(knowledgeGraph.nodes.map((node) => [node.id, node]));
  const structuralNodes = knowledgeGraph.nodes.filter((node) => STRUCTURAL_TYPES.has(node.label));
  const structuralSpread = Math.sqrt(nodeCount) * 40;
  const childJitter = Math.sqrt(nodeCount) * 3;
  const clusterJitter = Math.sqrt(nodeCount) * 1.5;
  const clusterCenters = new Map<number, { x: number; y: number }>();

  if (communityMemberships && communityMemberships.size > 0) {
    const communities = new Set(communityMemberships.values());
    const communityCount = communities.size;
    const clusterSpread = structuralSpread * 0.8;
    let communityOrder = 0;
    communities.forEach((communityId) => {
      const angle = communityOrder * GOLDEN_ANGLE;
      const radius = clusterSpread * Math.sqrt((communityOrder + 1) / communityCount);
      clusterCenters.set(communityId, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
      communityOrder += 1;
    });
  }

  const nodeIds: string[] = [];
  const edgeIds: string[] = [];
  const nodeIdToIndex = new Map<string, number>();
  const edgeIdToIndex = new Map<string, number>();
  const nodes: GraphRenderNode[] = [];
  const edges: GraphRenderEdge[] = [];
  const nodePositions = new Float32Array(Math.max(0, nodeCount * 3));
  const nodeColors = new Uint32Array(nodeCount);
  const nodeSeeds = new Uint32Array(nodeCount);
  const nodeVisibility = new Uint8Array(nodeCount);
  const nodePositionsById = new Map<string, { x: number; y: number }>();
  const zSpread = Math.sqrt(Math.max(1, nodeCount)) * 48;

  const addRenderNode = (
    node: GraphNode,
    x: number,
    y: number,
    communityIndex: number | undefined,
    baseColor: string,
    includeCommunityAttributes: boolean,
  ): void => {
    const index = nodes.length;
    const dependencyCount = dependencyCounts.get(node.id) ?? 0;
    const complexityScore = scoreByMax(complexityValues.get(node.id) ?? 0, maxComplexity);
    const churnScore = scoreByMax(churnValues.get(node.id) ?? 0, maxChurn);
    const attributes = createNodeAttributes({
      node,
      x,
      y,
      nodeCount,
      colorMode,
      baseColor,
      dependencyCounts,
      maxDependencyCount,
      maxRuntimeErrors,
      complexityScore,
      churnScore,
      impactScore: getImpactScore(node.id, dependencyCount),
      agentScore: getAgentScore(node.id),
      communityIndex,
      includeCommunityAttributes,
    });
    const communityOffset =
      communityIndex === undefined ? 0 : ((communityIndex % 9) - 4) * zSpread * 0.055;
    let z: number;
    if (depthMode === 'layered') {
      // Place the node on its architectural-depth stratum, with a small
      // deterministic jitter so a layer reads as a thick band, not a flat plane.
      const depthZ = depthLevelToZ(getNodeDepthLevel(node.label), zSpread);
      z = depthZ + centeredUnit(`${node.id}:depth`) * depthStratumGap(zSpread) * 0.6;
      attributes.z = z;
      attributes.depthZ = depthZ;
    } else {
      z = (hashToUnit(node.id) - 0.5) * zSpread + communityOffset;
    }

    nodeIdToIndex.set(node.id, index);
    nodeIds.push(node.id);
    nodeSeeds[index] = hashStringToUint32(`node:${node.id}`);
    nodePositions[index * 3] = x;
    nodePositions[index * 3 + 1] = y;
    nodePositions[index * 3 + 2] = z;
    nodeColors[index] = colorToNumber(attributes.color);
    nodeVisibility[index] = 1;
    nodePositionsById.set(node.id, { x, y });
    nodes.push({ id: node.id, index, seed: nodeSeeds[index], attributes });
  };

  structuralNodes.forEach((node, index) => {
    const angle = index * GOLDEN_ANGLE;
    const radius = structuralSpread * Math.sqrt((index + 1) / Math.max(structuralNodes.length, 1));
    const jitter = structuralSpread * 0.15;
    const x = radius * Math.cos(angle) + centeredUnit(`${node.id}:structural:x`) * jitter;
    const y = radius * Math.sin(angle) + centeredUnit(`${node.id}:structural:y`) * jitter;

    addRenderNode(node, x, y, undefined, getNodeTypeColor(node.label), false);
  });

  const addNodeWithPosition = (nodeId: string): void => {
    if (nodeIdToIndex.has(nodeId)) return;

    const node = nodeMap.get(nodeId);
    if (!node) return;

    let x: number;
    let y: number;
    const communityIndex = communityMemberships?.get(nodeId);
    const clusterCenter = communityIndex === undefined ? null : clusterCenters.get(communityIndex);

    if (clusterCenter && SYMBOL_TYPES.has(node.label)) {
      x = clusterCenter.x + centeredUnit(`${nodeId}:cluster:x`) * clusterJitter;
      y = clusterCenter.y + centeredUnit(`${nodeId}:cluster:y`) * clusterJitter;
    } else {
      const parentId = childToParent.get(nodeId);
      const parentPosition = parentId ? nodePositionsById.get(parentId) : null;

      if (parentPosition) {
        x = parentPosition.x + centeredUnit(`${nodeId}:child:x:${parentId}`) * childJitter;
        y = parentPosition.y + centeredUnit(`${nodeId}:child:y:${parentId}`) * childJitter;
      } else {
        x = centeredUnit(`${nodeId}:orphan:x`) * structuralSpread * 0.5;
        y = centeredUnit(`${nodeId}:orphan:y`) * structuralSpread * 0.5;
      }
    }

    const usesCommunityColor =
      colorMode === 'structure' && communityIndex !== undefined && SYMBOL_TYPES.has(node.label);
    const baseColor = usesCommunityColor
      ? getCommunityColor(communityIndex)
      : getNodeTypeColor(node.label);

    addRenderNode(node, x, y, communityIndex, baseColor, true);
  };

  const queue: string[] = [...structuralNodes.map((node) => node.id)];
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const children = parentToChildren.get(currentId) || [];
    for (const childId of children) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      addNodeWithPosition(childId);
      queue.push(childId);
    }
  }

  knowledgeGraph.nodes.forEach((node) => {
    if (!nodeIdToIndex.has(node.id)) {
      addNodeWithPosition(node.id);
    }
  });

  const edgeBaseSize = nodeCount > 20000 ? 0.4 : nodeCount > 5000 ? 0.6 : 1.0;
  const usedEdgeKeys = new Set<string>();
  const getUniqueEdgeKey = (baseKey: string): string => {
    if (!usedEdgeKeys.has(baseKey)) {
      usedEdgeKeys.add(baseKey);
      return baseKey;
    }

    let index = 2;
    let key = `${baseKey}#${index}`;
    while (usedEdgeKeys.has(key)) {
      index += 1;
      key = `${baseKey}#${index}`;
    }
    usedEdgeKeys.add(key);
    return key;
  };

  knowledgeGraph.relationships.forEach((relationship) => {
    const sourceIndex = nodeIdToIndex.get(relationship.sourceId);
    const targetIndex = nodeIdToIndex.get(relationship.targetId);
    if (sourceIndex === undefined || targetIndex === undefined) return;

    const style = getEdgeStyle(relationship.type);
    const edgeKey = getUniqueEdgeKey(
      relationship.id || `${relationship.sourceId}-${relationship.type}-${relationship.targetId}`,
    );
    const index = edges.length;
    const curvatureSeed = getDeterministicCurvatureSeed(edgeKey);
    const curvature = 0.12 + curvatureSeed * 0.08;
    const attributes: SigmaEdgeAttributes = {
      size: edgeBaseSize * style.sizeMultiplier,
      color: style.color,
      relationType: relationship.type,
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      confidence: relationship.confidence,
      reason: relationship.reason,
      type: 'curved',
      curvature,
    };

    edgeIds.push(edgeKey);
    edgeIdToIndex.set(edgeKey, index);
    edges.push({
      id: edgeKey,
      index,
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      sourceIndex,
      targetIndex,
      seed: hashStringToUint32(`edge:${edgeKey}`),
      curvatureSeed,
      attributes,
    });
  });

  const edgeCount = edges.length;
  const edgeSourceIndices = new Uint32Array(edgeCount);
  const edgeTargetIndices = new Uint32Array(edgeCount);
  const edgeColors = new Uint32Array(edgeCount);
  const edgeSeeds = new Uint32Array(edgeCount);
  const edgeCurvatureSeeds = new Float32Array(edgeCount);
  const edgeCurvatures = new Float32Array(edgeCount);
  const edgeCurveMultipliers = new Float32Array(edgeCount);
  const edgeVisibility = new Uint8Array(edgeCount);

  edges.forEach((edge, index) => {
    edgeSourceIndices[index] = edge.sourceIndex;
    edgeTargetIndices[index] = edge.targetIndex;
    edgeColors[index] = colorToNumber(edge.attributes.color);
    edgeSeeds[index] = edge.seed;
    edgeCurvatureSeeds[index] = edge.curvatureSeed;
    edgeCurvatures[index] = edge.attributes.curvature ?? 0;
    edgeCurveMultipliers[index] = getRelationCurveMultiplier(edge.attributes.relationType);
    edgeVisibility[index] = 1;
  });

  return {
    nodeCount,
    edgeCount,
    nodeIds,
    edgeIds,
    nodeIdToIndex,
    edgeIdToIndex,
    nodes,
    edges,
    nodePositions,
    nodeColors,
    nodeSeeds,
    nodeVisibility,
    nodeVisibilityBits: createVisibilityBitset(nodeVisibility),
    edgeSourceIndices,
    edgeTargetIndices,
    edgeColors,
    edgeSeeds,
    edgeCurvatureSeeds,
    edgeCurvatures,
    edgeCurveMultipliers,
    edgeVisibility,
    edgeVisibilityBits: createVisibilityBitset(edgeVisibility),
  };
};

export const graphRenderModelToGraphology = (
  model: GraphRenderModel,
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> => {
  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>({ multi: true });

  model.nodes.forEach((node) => {
    graph.addNode(node.id, { ...node.attributes });
  });

  model.edges.forEach((edge) => {
    graph.addDirectedEdgeWithKey(edge.id, edge.sourceId, edge.targetId, {
      ...edge.attributes,
    });
  });

  return graph;
};

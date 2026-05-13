import { useRef, useEffect, useCallback, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';
import EdgeCurveProgram from '@sigma/edge-curve';
import { SigmaNodeAttributes, SigmaEdgeAttributes } from '../lib/graph-adapter';
import type { NodeAnimation } from './useAppState';
import { GRAPH_SURFACE_COLORS, type EdgeType } from '../lib/constants';
import { resolveGraphEdgeVisual, resolveGraphNodeVisual } from '../lib/graph-visual-state';
import { GRAPH_PERF_METRICS, recordGraphPerf, type GraphPerfObserver } from '../lib/graph-perf';
import {
  createActiveAnimationSnapshot,
  createAnimationCacheKey,
  createStableCollectionSignature,
} from '../lib/sigma-visual-cache';

interface UseSigmaOptions {
  isActive?: boolean;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onStageClick?: () => void;
  highlightedNodeIds?: Set<string>;
  blastRadiusNodeIds?: Set<string>;
  animatedNodes?: Map<string, NodeAnimation>;
  visibleEdgeTypes?: EdgeType[];
  perfObserver?: GraphPerfObserver;
}

interface UseSigmaReturn {
  containerRef: React.RefObject<HTMLDivElement>;
  sigmaRef: React.RefObject<Sigma | null>;
  setGraph: (
    graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
    options?: SigmaSetGraphOptions,
  ) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusNode: (nodeId: string) => void;
  isLayoutRunning: boolean;
  startLayout: () => void;
  stopLayout: () => void;
  selectedNode: string | null;
  setSelectedNode: (nodeId: string | null) => void;
  refreshHighlights: () => void;
}

interface SigmaSetGraphOptions {
  runLayout?: boolean;
  resetCamera?: boolean;
  clearSelection?: boolean;
}

type LayoutBudget = {
  minDurationMs: number;
  maxDurationMs: number;
  sampleIntervalMs: number;
  movementThreshold: number;
  maxMovementThreshold: number;
  stableSamples: number;
};

type LayoutSnapshot = Map<string, { x: number; y: number }>;

type CachedReducerEntry<T> = {
  signature: string;
  output: T;
};

type CachedReducerAttributes = Record<string, unknown>;

const createNodeBaseSignature = (data: CachedReducerAttributes): string =>
  [data.x, data.y, data.z ?? '', data.hidden ? 1 : 0, data.color, data.size, data.label].join('|');

const createEdgeBaseSignature = (data: CachedReducerAttributes): string =>
  [
    data.hidden ? 1 : 0,
    data.color,
    data.size,
    data.relationType,
    data.type ?? '',
    data.curvature ?? '',
  ].join('|');

const snapshotLayout = (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>): LayoutSnapshot => {
  const positions: LayoutSnapshot = new Map();

  graph.forEachNode((nodeId, attributes) => {
    positions.set(nodeId, { x: attributes.x, y: attributes.y });
  });

  return positions;
};

const measureLayoutMovement = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  previousPositions: LayoutSnapshot,
) => {
  const nextPositions: LayoutSnapshot = new Map();
  let totalMovement = 0;
  let maxMovement = 0;
  let measuredNodes = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  graph.forEachNode((nodeId, attributes) => {
    const x = attributes.x;
    const y = attributes.y;
    const previous = previousPositions.get(nodeId);

    if (previous) {
      const movement = Math.hypot(x - previous.x, y - previous.y);
      totalMovement += movement;
      maxMovement = Math.max(maxMovement, movement);
      measuredNodes += 1;
    }

    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    nextPositions.set(nodeId, { x, y });
  });

  const graphDiagonal = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
  const averageMovement = measuredNodes > 0 ? totalMovement / measuredNodes : 0;

  return {
    positions: nextPositions,
    averageMovement: averageMovement / graphDiagonal,
    maxMovement: maxMovement / graphDiagonal,
  };
};

export const getNoverlapSettings = (nodeCount: number) => ({
  maxIterations: nodeCount > 10000 ? 32 : nodeCount > 5000 ? 42 : nodeCount > 2000 ? 55 : 80,
  ratio: nodeCount > 5000 ? 1.04 : 1.1,
  margin: nodeCount > 5000 ? 6 : 10,
  expansion: 1.05,
});

// ForceAtlas2 settings - optimized for fast convergence from the seeded hierarchy/community layout.
export const getFA2Settings = (nodeCount: number) => {
  const isSmall = nodeCount < 500;
  const isMedium = nodeCount >= 500 && nodeCount < 2000;
  const isLarge = nodeCount >= 2000 && nodeCount < 10000;
  const isHuge = nodeCount >= 10000;

  return {
    // Lower gravity allows folders to stay spread out
    gravity: isSmall ? 0.8 : isMedium ? 0.5 : isLarge ? 0.3 : 0.15,

    // Higher scaling ratio = more spread out overall
    scalingRatio: isSmall ? 15 : isMedium ? 30 : isLarge ? 60 : 100,

    // LOW slowDown = FASTER movement (converges quicker)
    slowDown: isSmall ? 0.65 : isMedium ? 1 : isLarge ? 1.55 : 2.2,

    // Barnes-Hut for performance - use it even on smaller graphs
    barnesHutOptimize: nodeCount > 150,
    barnesHutTheta: isHuge ? 0.95 : isLarge ? 0.85 : 0.7,

    // Large anti-collision inside FA2 is costly; the final noverlap pass
    // handles cleanup after the graph has reached a useful shape.
    strongGravityMode: false,
    outboundAttractionDistribution: true,
    linLogMode: false,
    adjustSizes: nodeCount < 5000,
    edgeWeightInfluence: 1,
  };
};

// Let FA2 run until movement settles enough for navigation, with a safety cap
// to avoid an accidental infinite worker on pathological graphs.
export const getLayoutBudget = (nodeCount: number): LayoutBudget => {
  if (nodeCount > 10000) {
    return {
      minDurationMs: 60000,
      maxDurationMs: 300000,
      sampleIntervalMs: 1750,
      movementThreshold: 0.0006,
      maxMovementThreshold: 0.007,
      stableSamples: 4,
    };
  }
  if (nodeCount > 5000) {
    return {
      minDurationMs: 45000,
      maxDurationMs: 210000,
      sampleIntervalMs: 1500,
      movementThreshold: 0.00065,
      maxMovementThreshold: 0.0075,
      stableSamples: 4,
    };
  }
  if (nodeCount > 2000) {
    return {
      minDurationMs: 30000,
      maxDurationMs: 150000,
      sampleIntervalMs: 1250,
      movementThreshold: 0.00075,
      maxMovementThreshold: 0.008,
      stableSamples: 3,
    };
  }
  if (nodeCount > 1000) {
    return {
      minDurationMs: 22000,
      maxDurationMs: 105000,
      sampleIntervalMs: 1000,
      movementThreshold: 0.0009,
      maxMovementThreshold: 0.009,
      stableSamples: 3,
    };
  }
  if (nodeCount > 500) {
    return {
      minDurationMs: 14000,
      maxDurationMs: 75000,
      sampleIntervalMs: 900,
      movementThreshold: 0.00105,
      maxMovementThreshold: 0.01,
      stableSamples: 3,
    };
  }
  return {
    minDurationMs: 10000,
    maxDurationMs: 45000,
    sampleIntervalMs: 800,
    movementThreshold: 0.0012,
    maxMovementThreshold: 0.011,
    stableSamples: 2,
  };
};

export const useSigma = (options: UseSigmaOptions = {}): UseSigmaReturn => {
  const containerRef = useRef<HTMLDivElement>(null!);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  const highlightedRef = useRef<Set<string>>(new Set());
  const blastRadiusRef = useRef<Set<string>>(new Set());
  const animatedNodesRef = useRef<Map<string, NodeAnimation>>(new Map());
  const activeAnimatedNodesRef = useRef<Map<string, NodeAnimation>>(new Map());
  const visibleEdgeTypesRef = useRef<EdgeType[] | null>(null);
  const visibleEdgeTypesSetRef = useRef<Set<EdgeType> | null>(null);
  const optionsRef = useRef(options);
  const isActiveRef = useRef(options.isActive ?? true);
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutMonitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const layoutRunIdRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const graphVersionRef = useRef(0);
  const nodeVisualStateVersionRef = useRef(0);
  const edgeVisualStateVersionRef = useRef(0);
  const nodeVisualStateSignatureRef = useRef('');
  const edgeVisualStateSignatureRef = useRef('');
  const animationFrameVersionRef = useRef(0);
  const animationNowRef = useRef(Date.now());
  const nodeVisualCacheRef = useRef(new Map<string, CachedReducerEntry<CachedReducerAttributes>>());
  const edgeVisualCacheRef = useRef(new Map<string, CachedReducerEntry<CachedReducerAttributes>>());
  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [selectedNode, setSelectedNodeState] = useState<string | null>(null);

  useEffect(() => {
    optionsRef.current = options;
    isActiveRef.current = options.isActive ?? true;
  });

  const isRendererActive = useCallback(() => isActiveRef.current, []);

  const recordSigmaRefresh = useCallback((label: string) => {
    recordGraphPerf(optionsRef.current.perfObserver, GRAPH_PERF_METRICS.sigmaRefresh, { label });
  }, []);

  const syncVisualStateVersions = useCallback(() => {
    const selectedSignature = selectedNodeRef.current ?? '';
    const highlightedSignature = createStableCollectionSignature(highlightedRef.current);
    const blastRadiusSignature = createStableCollectionSignature(blastRadiusRef.current);
    const nodeSignature = [selectedSignature, highlightedSignature, blastRadiusSignature].join('|');

    if (nodeSignature !== nodeVisualStateSignatureRef.current) {
      nodeVisualStateSignatureRef.current = nodeSignature;
      nodeVisualStateVersionRef.current += 1;
    }

    const edgeSignature = [
      nodeSignature,
      createStableCollectionSignature(visibleEdgeTypesRef.current),
    ].join('|');

    if (edgeSignature !== edgeVisualStateSignatureRef.current) {
      edgeVisualStateSignatureRef.current = edgeSignature;
      edgeVisualStateVersionRef.current += 1;
    }
  }, []);

  const syncActiveAnimations = useCallback((now: number): boolean => {
    const snapshot = createActiveAnimationSnapshot(animatedNodesRef.current, now);
    activeAnimatedNodesRef.current = snapshot.animations;
    animationNowRef.current = now;
    return snapshot.hasActiveAnimations;
  }, []);

  const prepareAnimationFrame = useCallback(
    (now = Date.now()): boolean => {
      animationFrameVersionRef.current += 1;
      return syncActiveAnimations(now);
    },
    [syncActiveAnimations],
  );

  const refreshSigma = useCallback(
    (label: string, refreshOptions: { syncAnimations?: boolean } = {}) => {
      const sigma = sigmaRef.current;
      if (!sigma || !isRendererActive()) return;

      if ((refreshOptions.syncAnimations ?? true) && animatedNodesRef.current.size > 0) {
        prepareAnimationFrame();
      }

      sigma.refresh();
      recordSigmaRefresh(label);
    },
    [isRendererActive, prepareAnimationFrame, recordSigmaRefresh],
  );

  const clearLayoutTimers = useCallback(() => {
    if (layoutTimeoutRef.current) {
      clearTimeout(layoutTimeoutRef.current);
      layoutTimeoutRef.current = null;
    }
    if (layoutMonitorRef.current) {
      clearInterval(layoutMonitorRef.current);
      layoutMonitorRef.current = null;
    }
  }, []);

  const finishLayoutRun = useCallback(
    (runId: number, graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>, runNoverlap = true) => {
      if (layoutRunIdRef.current !== runId) return;

      clearLayoutTimers();

      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }

      if (runNoverlap && isRendererActive() && graph.order > 1) {
        noverlap.assign(graph, getNoverlapSettings(graph.order));
        refreshSigma('noverlap');
      }

      setIsLayoutRunning(false);
    },
    [clearLayoutTimers, isRendererActive, refreshSigma],
  );

  useEffect(() => {
    highlightedRef.current = options.highlightedNodeIds || new Set();
    blastRadiusRef.current = options.blastRadiusNodeIds || new Set();
    animatedNodesRef.current = options.animatedNodes || new Map();
    visibleEdgeTypesRef.current = options.visibleEdgeTypes || null;
    visibleEdgeTypesSetRef.current = options.visibleEdgeTypes
      ? new Set(options.visibleEdgeTypes)
      : null;
    syncVisualStateVersions();
    if (isRendererActive()) {
      prepareAnimationFrame();
      refreshSigma('visual-options', { syncAnimations: false });
    }
  }, [
    options.highlightedNodeIds,
    options.blastRadiusNodeIds,
    options.animatedNodes,
    options.visibleEdgeTypes,
    options.isActive,
    isRendererActive,
    prepareAnimationFrame,
    refreshSigma,
    syncVisualStateVersions,
  ]);

  // Animation loop for node effects
  useEffect(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (!isRendererActive() || !options.animatedNodes || options.animatedNodes.size === 0) {
      activeAnimatedNodesRef.current = new Map();
      return;
    }

    const animate = () => {
      if (!isRendererActive()) {
        animationFrameRef.current = null;
        return;
      }

      const hasActiveAnimations = prepareAnimationFrame();
      refreshSigma(hasActiveAnimations ? 'animation' : 'animation-final', {
        syncAnimations: false,
      });
      animationFrameRef.current = hasActiveAnimations ? requestAnimationFrame(animate) : null;
    };

    if (prepareAnimationFrame()) {
      animationFrameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [
    options.animatedNodes,
    options.isActive,
    isRendererActive,
    prepareAnimationFrame,
    refreshSigma,
  ]);

  const setSelectedNode = useCallback(
    (nodeId: string | null) => {
      selectedNodeRef.current = nodeId;
      setSelectedNodeState(nodeId);
      syncVisualStateVersions();

      if (!isRendererActive()) return;

      const sigma = sigmaRef.current;
      if (!sigma) return;

      // Tiny camera nudge to force edge refresh (workaround for Sigma edge caching)
      const camera = sigma.getCamera();
      const currentRatio = camera.ratio;
      // Imperceptible zoom change that triggers re-render
      camera.animate({ ratio: currentRatio * 1.0001 }, { duration: 50 });

      refreshSigma('selection');
    },
    [isRendererActive, refreshSigma, syncVisualStateVersions],
  );

  // Initialize Sigma ONCE
  useEffect(() => {
    if (!containerRef.current) return;

    const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
    graphRef.current = graph;

    const sigma = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: true,
      renderLabels: true,
      labelFont: 'JetBrains Mono, monospace',
      labelSize: 11,
      labelWeight: '500',
      labelColor: { color: '#e4e4ed' },
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.1,
      labelGridCellSize: 70,

      defaultNodeColor: GRAPH_SURFACE_COLORS.defaultNode,
      defaultEdgeColor: GRAPH_SURFACE_COLORS.defaultEdge,

      defaultEdgeType: 'curved',
      edgeProgramClasses: {
        curved: EdgeCurveProgram,
      },

      // Custom hover renderer - dark background instead of white
      defaultDrawNodeHover: (context, data, settings) => {
        const label = data.label;
        if (!label) return;

        const size = settings.labelSize || 11;
        const font = settings.labelFont || 'JetBrains Mono, monospace';
        const weight = settings.labelWeight || '500';

        context.font = `${weight} ${size}px ${font}`;
        const textWidth = context.measureText(label).width;

        const nodeSize = data.size || 8;
        const x = data.x;
        const y = data.y - nodeSize - 10;
        const paddingX = 8;
        const paddingY = 5;
        const height = size + paddingY * 2;
        const width = textWidth + paddingX * 2;
        const radius = 4;

        // Dark background pill
        context.fillStyle = GRAPH_SURFACE_COLORS.tooltipBackground;
        context.beginPath();
        context.roundRect(x - width / 2, y - height / 2, width, height, radius);
        context.fill();

        // Border matching node color
        context.strokeStyle = data.color || GRAPH_SURFACE_COLORS.fallbackNode;
        context.lineWidth = 2;
        context.stroke();

        // Label text - light color
        context.fillStyle = GRAPH_SURFACE_COLORS.tooltipText;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, x, y);

        // Also draw a subtle glow ring around the node
        context.beginPath();
        context.arc(data.x, data.y, nodeSize + 4, 0, Math.PI * 2);
        context.strokeStyle = data.color || GRAPH_SURFACE_COLORS.fallbackNode;
        context.lineWidth = 2;
        context.globalAlpha = 0.5;
        context.stroke();
        context.globalAlpha = 1;
      },

      minCameraRatio: 0.002,
      maxCameraRatio: 50,
      hideEdgesOnMove: true,
      zIndex: true,

      nodeReducer: (node, data) => {
        const animation = data.hidden ? null : activeAnimatedNodesRef.current.get(node);
        const animationKey = animation
          ? createAnimationCacheKey(animation, animationFrameVersionRef.current)
          : 'none';
        const signature = [
          graphVersionRef.current,
          nodeVisualStateVersionRef.current,
          animationKey,
          createNodeBaseSignature(data),
        ].join('|');
        const cached = nodeVisualCacheRef.current.get(node);
        if (cached?.signature === signature) {
          return cached.output;
        }

        const res = { ...data };

        if (data.hidden) {
          res.hidden = true;
          nodeVisualCacheRef.current.set(node, { signature, output: res });
          return res;
        }

        const currentSelected = selectedNodeRef.current;
        const graph = graphRef.current;
        const visual = resolveGraphNodeVisual({
          nodeId: node,
          color: data.color || GRAPH_SURFACE_COLORS.fallbackNode,
          size: data.size || 8,
          selectedNodeId: currentSelected,
          highlightedNodeIds: highlightedRef.current,
          blastRadiusNodeIds: blastRadiusRef.current,
          animatedNodes: activeAnimatedNodesRef.current,
          now: animationNowRef.current,
          isNeighbor: currentSelected
            ? Boolean(
                graph?.hasEdge(node, currentSelected) || graph?.hasEdge(currentSelected, node),
              )
            : false,
        });

        res.color = visual.color;
        res.size = visual.size;
        res.zIndex = visual.zIndex;
        res.highlighted = visual.highlighted;

        nodeVisualCacheRef.current.set(node, { signature, output: res });
        return res;
      },

      edgeReducer: (edge, data) => {
        const signature = [
          graphVersionRef.current,
          edgeVisualStateVersionRef.current,
          createEdgeBaseSignature(data),
        ].join('|');
        const cached = edgeVisualCacheRef.current.get(edge);
        if (cached?.signature === signature) {
          return cached.output;
        }

        const res = { ...data };

        // Check edge type visibility first
        const visibleTypes = visibleEdgeTypesSetRef.current;
        if (visibleTypes && data.relationType) {
          if (!visibleTypes.has(data.relationType as EdgeType)) {
            res.hidden = true;
            edgeVisualCacheRef.current.set(edge, { signature, output: res });
            return res;
          }
        }

        const currentSelected = selectedNodeRef.current;
        const highlighted = highlightedRef.current;
        const blastRadius = blastRadiusRef.current;

        const graph = graphRef.current;
        if (graph) {
          const [source, target] = graph.extremities(edge);
          const visual = resolveGraphEdgeVisual({
            sourceId: source,
            targetId: target,
            color: data.color || GRAPH_SURFACE_COLORS.fallbackEdge,
            size: data.size || 1,
            selectedNodeId: currentSelected,
            highlightedNodeIds: highlighted,
            blastRadiusNodeIds: blastRadius,
          });

          res.color = visual.color;
          res.size = visual.size;
          res.zIndex = visual.zIndex;
        }

        edgeVisualCacheRef.current.set(edge, { signature, output: res });
        return res;
      },
    });

    sigmaRef.current = sigma;

    sigma.on('clickNode', ({ node }) => {
      setSelectedNode(node);
      optionsRef.current.onNodeClick?.(node);
    });

    sigma.on('clickStage', () => {
      setSelectedNode(null);
      optionsRef.current.onStageClick?.();
    });

    sigma.on('enterNode', ({ node }) => {
      optionsRef.current.onNodeHover?.(node);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'pointer';
      }
    });

    sigma.on('leaveNode', () => {
      optionsRef.current.onNodeHover?.(null);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'grab';
      }
    });

    return () => {
      layoutRunIdRef.current += 1;
      if (layoutTimeoutRef.current) {
        clearTimeout(layoutTimeoutRef.current);
      }
      if (layoutMonitorRef.current) {
        clearInterval(layoutMonitorRef.current);
      }
      layoutRef.current?.kill();
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, []);

  // Run ForceAtlas2 layout
  const runLayout = useCallback(
    (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
      const nodeCount = graph.order;
      if (nodeCount === 0 || !isRendererActive()) return;

      // Kill existing
      layoutRunIdRef.current += 1;
      clearLayoutTimers();
      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }

      const runId = layoutRunIdRef.current;
      const budget = getLayoutBudget(nodeCount);
      let previousPositions = snapshotLayout(graph);
      let stableSamples = 0;
      let movedSamples = 0;
      const startedAt = Date.now();

      // Get settings
      const inferredSettings = forceAtlas2.inferSettings(graph);
      const customSettings = getFA2Settings(nodeCount);
      const settings = { ...inferredSettings, ...customSettings };

      const layout = new FA2Layout(graph, { settings });

      layoutRef.current = layout;
      layout.start();
      setIsLayoutRunning(true);

      layoutMonitorRef.current = setInterval(() => {
        if (layoutRunIdRef.current !== runId || !layoutRef.current?.isRunning()) return;

        const movement = measureLayoutMovement(graph, previousPositions);
        previousPositions = movement.positions;

        if (movement.averageMovement > 0) {
          movedSamples += 1;
        }

        const elapsedMs = Date.now() - startedAt;
        const isSettled =
          elapsedMs >= budget.minDurationMs &&
          movedSamples >= 2 &&
          movement.averageMovement > 0 &&
          movement.averageMovement <= budget.movementThreshold &&
          movement.maxMovement <= budget.maxMovementThreshold;

        stableSamples = isSettled ? stableSamples + 1 : 0;

        if (stableSamples >= budget.stableSamples) {
          finishLayoutRun(runId, graph);
        }
      }, budget.sampleIntervalMs);

      layoutTimeoutRef.current = setTimeout(() => {
        finishLayoutRun(runId, graph);
      }, budget.maxDurationMs);
    },
    [clearLayoutTimers, finishLayoutRun, isRendererActive],
  );

  const setGraph = useCallback(
    (
      newGraph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
      options: SigmaSetGraphOptions = {},
    ) => {
      const sigma = sigmaRef.current;
      if (!sigma) return;

      const shouldRunLayout = options.runLayout ?? true;
      const shouldResetCamera = options.resetCamera ?? true;
      const shouldClearSelection = options.clearSelection ?? true;

      layoutRunIdRef.current += 1;
      clearLayoutTimers();
      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }
      setIsLayoutRunning(false);

      graphVersionRef.current += 1;
      nodeVisualCacheRef.current.clear();
      edgeVisualCacheRef.current.clear();
      graphRef.current = newGraph;
      sigma.setGraph(newGraph);
      if (shouldClearSelection) {
        setSelectedNode(null);
      }

      if (shouldRunLayout && isRendererActive()) {
        runLayout(newGraph);
      } else if (isRendererActive()) {
        refreshSigma('setGraph');
      }
      if (shouldResetCamera && isRendererActive()) {
        sigma.getCamera().animatedReset({ duration: 500 });
      }
    },
    [clearLayoutTimers, isRendererActive, refreshSigma, runLayout, setSelectedNode],
  );

  const focusNode = useCallback(
    (nodeId: string) => {
      const sigma = sigmaRef.current;
      const graph = graphRef.current;
      if (!sigma || !graph || !graph.hasNode(nodeId) || !isRendererActive()) return;

      // Skip if already focused on this node (prevents double-click issues)
      const alreadySelected = selectedNodeRef.current === nodeId;

      // Set selection state directly (without the camera nudge from setSelectedNode)
      selectedNodeRef.current = nodeId;
      setSelectedNodeState(nodeId);
      syncVisualStateVersions();

      // Only animate camera if selecting a new node
      if (!alreadySelected) {
        const nodeAttrs = graph.getNodeAttributes(nodeId);
        sigma
          .getCamera()
          .animate({ x: nodeAttrs.x, y: nodeAttrs.y, ratio: 0.15 }, { duration: 400 });
      }

      refreshSigma('focus');
    },
    [isRendererActive, refreshSigma, syncVisualStateVersions],
  );

  const zoomIn = useCallback(() => {
    sigmaRef.current?.getCamera().animatedZoom({ duration: 200 });
  }, []);

  const zoomOut = useCallback(() => {
    sigmaRef.current?.getCamera().animatedUnzoom({ duration: 200 });
  }, []);

  const resetZoom = useCallback(() => {
    sigmaRef.current?.getCamera().animatedReset({ duration: 300 });
    setSelectedNode(null);
  }, [setSelectedNode]);

  const startLayout = useCallback(() => {
    const graph = graphRef.current;
    if (!graph || graph.order === 0) return;
    runLayout(graph);
  }, [runLayout]);

  const stopLayout = useCallback(() => {
    const graph = graphRef.current;
    if (graph) {
      finishLayoutRun(layoutRunIdRef.current, graph);
    } else {
      clearLayoutTimers();
      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }
      setIsLayoutRunning(false);
    }
  }, [clearLayoutTimers, finishLayoutRun]);

  useEffect(() => {
    isActiveRef.current = options.isActive ?? true;

    if (!isRendererActive()) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      layoutRunIdRef.current += 1;
      clearLayoutTimers();
      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }
      setIsLayoutRunning(false);
      return;
    }

    syncVisualStateVersions();
    prepareAnimationFrame();
    refreshSigma('resume', { syncAnimations: false });
  }, [
    options.isActive,
    clearLayoutTimers,
    isRendererActive,
    prepareAnimationFrame,
    refreshSigma,
    syncVisualStateVersions,
  ]);

  const refreshHighlights = useCallback(() => {
    refreshSigma('manual');
  }, [refreshSigma]);

  return {
    containerRef,
    sigmaRef,
    setGraph,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    isLayoutRunning,
    startLayout,
    stopLayout,
    selectedNode,
    setSelectedNode,
    refreshHighlights,
  };
};

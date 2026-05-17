import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  Box,
  Focus,
  Lightbulb,
  LightbulbOff,
  Maximize2,
  Navigation,
  Orbit,
  Pause,
  Play,
  RotateCcw,
  Square,
  ZoomIn,
  ZoomOut,
} from '@/lib/lucide-icons';
import { useSigma } from '../hooks/useSigma';
import { useThreeGraph } from '../hooks/useThreeGraph';
import { useAppState } from '../hooks/useAppState';
import {
  knowledgeGraphToGraphology,
  filterGraphByDepth,
  SigmaNodeAttributes,
  SigmaEdgeAttributes,
} from '../lib/graph-adapter';
import { GRAPH_SURFACE_COLORS } from '../lib/constants';
import type { GraphNode } from 'gitnexus-shared';
import { QueryFAB } from './QueryFAB';
import Graph from 'graphology';

export interface GraphCanvasHandle {
  focusNode: (nodeId: string) => void;
}

type GraphViewMode = '2d' | '3d';

export const GraphCanvas = forwardRef<GraphCanvasHandle>((_, ref) => {
  const {
    graph,
    setSelectedNode,
    selectedNode: appSelectedNode,
    visibleLabels,
    visibleEdgeTypes,
    openCodePanel,
    depthFilter,
    highlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    animatedNodes,
  } = useAppState();
  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);
  const [graphViewMode, setGraphViewMode] = useState<GraphViewMode>('2d');
  const is3DMode = graphViewMode === '3d';
  // Track the active graph view in a ref so the data-sync effect can stop the
  // inactive renderer's layout without depending on `graphViewMode` and
  // re-running every time the user toggles between 2D and 3D.
  const graphViewModeRef = useRef<GraphViewMode>('2d');
  useEffect(() => {
    graphViewModeRef.current = graphViewMode;
  }, [graphViewMode]);

  const effectiveHighlightedNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return highlightedNodeIds;
    const next = new Set(highlightedNodeIds);
    for (const id of aiCitationHighlightedNodeIds) next.add(id);
    for (const id of aiToolHighlightedNodeIds) next.add(id);
    // Note: blast radius nodes are handled separately with red color
    return next;
  }, [
    highlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    isAIHighlightsEnabled,
  ]);

  // Blast radius nodes (only when AI highlights enabled)
  const effectiveBlastRadiusNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Set<string>();
    return blastRadiusNodeIds;
  }, [blastRadiusNodeIds, isAIHighlightsEnabled]);

  // Animated nodes (only when AI highlights enabled)
  const effectiveAnimatedNodes = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Map();
    return animatedNodes;
  }, [animatedNodes, isAIHighlightsEnabled]);

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>();
    return new Map(graph.nodes.map((n) => [n.id, n]));
  }, [graph]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (!graph) return;
      const node = nodeById.get(nodeId);
      if (node) {
        setSelectedNode(node);
        openCodePanel();
      }
    },
    [graph, nodeById, setSelectedNode, openCodePanel],
  );

  const handleNodeHover = useCallback(
    (nodeId: string | null) => {
      if (!nodeId || !graph) {
        setHoveredNodeName(null);
        return;
      }
      const node = nodeById.get(nodeId);
      setHoveredNodeName(node ? node.properties.name : null);
    },
    [graph, nodeById],
  );

  const handleStageClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  const {
    containerRef: sigmaContainerRef,
    sigmaRef,
    setGraph: setSigmaGraph,
    zoomIn: sigmaZoomIn,
    zoomOut: sigmaZoomOut,
    resetZoom: sigmaResetZoom,
    focusNode: sigmaFocusNode,
    isLayoutRunning: isSigmaLayoutRunning,
    startLayout: startSigmaLayout,
    stopLayout: stopSigmaLayout,
    selectedNode: sigmaSelectedNode,
    setSelectedNode: setSigmaSelectedNode,
  } = useSigma({
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onStageClick: handleStageClick,
    highlightedNodeIds: effectiveHighlightedNodeIds,
    blastRadiusNodeIds: effectiveBlastRadiusNodeIds,
    animatedNodes: effectiveAnimatedNodes,
    visibleEdgeTypes,
  });

  const {
    containerRef: threeContainerRef,
    setGraph: setThreeGraph,
    zoomIn: threeZoomIn,
    zoomOut: threeZoomOut,
    resetZoom: threeResetZoom,
    focusNode: threeFocusNode,
    isLayoutRunning: isThreeLayoutRunning,
    startLayout: startThreeLayout,
    stopLayout: stopThreeLayout,
    selectedNode: threeSelectedNode,
    setSelectedNode: setThreeSelectedNode,
    cameraMode,
    setCameraMode,
  } = useThreeGraph({
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onStageClick: handleStageClick,
    highlightedNodeIds: effectiveHighlightedNodeIds,
    blastRadiusNodeIds: effectiveBlastRadiusNodeIds,
    animatedNodes: effectiveAnimatedNodes,
    visibleEdgeTypes,
  });

  const zoomIn = is3DMode ? threeZoomIn : sigmaZoomIn;
  const zoomOut = is3DMode ? threeZoomOut : sigmaZoomOut;
  const resetZoom = is3DMode ? threeResetZoom : sigmaResetZoom;
  const focusNode = is3DMode ? threeFocusNode : sigmaFocusNode;
  const isLayoutRunning = is3DMode ? isThreeLayoutRunning : isSigmaLayoutRunning;
  const startLayout = is3DMode ? startThreeLayout : startSigmaLayout;
  const stopLayout = is3DMode ? stopThreeLayout : stopSigmaLayout;
  const rendererSelectedNode = is3DMode ? threeSelectedNode : sigmaSelectedNode;

  const handleToggleAIHighlights = useCallback(() => {
    if (isAIHighlightsEnabled) {
      clearAIToolHighlights();
      clearAICitationHighlights();
      clearBlastRadius();
      setSelectedNode(null);
      setSigmaSelectedNode(null);
      setThreeSelectedNode(null);
    }
    toggleAIHighlights();
  }, [
    isAIHighlightsEnabled,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    setSelectedNode,
    setSigmaSelectedNode,
    setThreeSelectedNode,
    toggleAIHighlights,
  ]);

  // Expose focusNode to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      focusNode: (nodeId: string) => {
        // Also update app state so the selection syncs properly
        if (graph) {
          const node = nodeById.get(nodeId);
          if (node) {
            setSelectedNode(node);
            openCodePanel();
          }
        }
        focusNode(nodeId);
      },
    }),
    [focusNode, graph, nodeById, setSelectedNode, openCodePanel],
  );

  // Push graph data into both renderers (Sigma + Three) whenever the
  // KnowledgeGraph changes. Each renderer keeps its own Graphology instance so
  // we build the graph twice rather than sharing the same mutable object.
  useEffect(() => {
    if (!graph) return;

    // Build communityMemberships map from MEMBER_OF relationships
    // MEMBER_OF edges: nodeId -> communityId (stored as targetId)
    const communityMemberships = new Map<string, number>();
    graph.relationships.forEach((rel) => {
      if (rel.type === 'MEMBER_OF') {
        // Find the community node to get its index
        const communityNode = nodeById.get(rel.targetId);
        if (communityNode && communityNode.label === 'Community') {
          // Extract community index from id (e.g., "comm_5" -> 5)
          const numericPart = rel.targetId.replace('comm_', '');
          const communityIdx = /^\d+$/.test(numericPart) ? parseInt(numericPart, 10) : 0;
          communityMemberships.set(rel.sourceId, communityIdx);
        }
      }
    });

    setSigmaGraph(knowledgeGraphToGraphology(graph, communityMemberships));
    setThreeGraph(knowledgeGraphToGraphology(graph, communityMemberships));

    // Whichever renderer is hidden should not be running a force layout in the
    // background — that wastes a worker and produces unrelated motion if the
    // user toggles back later.
    if (graphViewModeRef.current === '2d') {
      stopThreeLayout();
    } else {
      stopSigmaLayout();
    }
  }, [graph, nodeById, setSigmaGraph, setThreeGraph, stopSigmaLayout, stopThreeLayout]);

  // Update node visibility when filters change
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    const sigmaGraph = sigma.getGraph() as Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;
    if (sigmaGraph.order === 0) return; // Don't filter empty graph

    filterGraphByDepth(sigmaGraph, appSelectedNode?.id || null, depthFilter, visibleLabels);
    sigma.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sigmaRef identity never changes
  }, [visibleLabels, depthFilter, appSelectedNode]);

  // Sync app selected node with both renderers
  useEffect(() => {
    const id = appSelectedNode ? appSelectedNode.id : null;
    setSigmaSelectedNode(id);
    setThreeSelectedNode(id);
  }, [appSelectedNode, setSigmaSelectedNode, setThreeSelectedNode]);

  // Focus on selected node
  const handleFocusSelected = useCallback(() => {
    if (appSelectedNode) {
      focusNode(appSelectedNode.id);
    }
  }, [appSelectedNode, focusNode]);

  // Clear selection
  const handleClearSelection = useCallback(() => {
    setSelectedNode(null);
    setSigmaSelectedNode(null);
    setThreeSelectedNode(null);
    resetZoom();
  }, [setSelectedNode, setSigmaSelectedNode, setThreeSelectedNode, resetZoom]);

  return (
    <div className="relative h-full w-full bg-void">
      {/* Background gradient */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.03) 0%, transparent 70%),
              linear-gradient(to bottom, ${GRAPH_SURFACE_COLORS.background}, ${GRAPH_SURFACE_COLORS.backgroundSoft})
            `,
          }}
        />
      </div>

      {/* Graph renderers — both stay mounted so toggling between 2D and 3D
          preserves layout positions and selection state. The inactive view is
          faded out and made inert via opacity + pointer-events. */}
      <div className="absolute inset-0 z-[1]">
        <div
          ref={sigmaContainerRef}
          data-testid="sigma-graph-container"
          className={`sigma-container absolute inset-0 cursor-grab transition-opacity duration-200 active:cursor-grabbing ${
            graphViewMode === '2d' ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          aria-hidden={graphViewMode !== '2d'}
        />
        <div
          ref={threeContainerRef}
          data-testid="three-graph-container"
          className={`three-graph-container absolute inset-0 cursor-grab transition-opacity duration-200 active:cursor-grabbing ${
            graphViewMode === '3d' ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          aria-hidden={graphViewMode !== '3d'}
        />
      </div>

      {/* Hovered node tooltip - only show when NOT selected */}
      {hoveredNodeName && !rendererSelectedNode && (
        <div className="pointer-events-none absolute top-4 left-1/2 z-20 -translate-x-1/2 animate-fade-in rounded-lg border border-border-subtle bg-elevated/95 px-3 py-1.5 backdrop-blur-sm">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {/* Selection info bar */}
      {rendererSelectedNode && appSelectedNode && (
        <div className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 animate-slide-up items-center gap-2 rounded-xl border border-accent/30 bg-accent/20 px-4 py-2 backdrop-blur-sm">
          <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          <span className="font-mono text-sm text-text-primary">
            {appSelectedNode.properties.name}
          </span>
          <span className="text-xs text-text-muted">({appSelectedNode.label})</span>
          <button
            onClick={handleClearSelection}
            className="ml-2 rounded px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
          >
            Clear
          </button>
        </div>
      )}

      {/* Graph Controls - Bottom Right */}
      <div className="absolute right-4 bottom-4 z-10 flex flex-col gap-1">
        <button
          onClick={zoomIn}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Zoom In"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          onClick={zoomOut}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Zoom Out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          onClick={resetZoom}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Fit to Screen"
        >
          <Maximize2 className="h-4 w-4" />
        </button>

        {/* Divider */}
        <div className="my-1 h-px bg-border-subtle" />

        {/* View mode */}
        <button
          onClick={() => setGraphViewMode('2d')}
          className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
            graphViewMode === '2d'
              ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
              : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
          title="2D Graph"
          data-testid="graph-view-2d-toggle"
        >
          <Square className="h-4 w-4" />
        </button>
        <button
          onClick={() => setGraphViewMode('3d')}
          className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
            graphViewMode === '3d'
              ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
              : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
          title="3D Graph"
          data-testid="graph-view-3d-toggle"
        >
          <Box className="h-4 w-4" />
        </button>

        {/* Divider */}
        <div className="my-1 h-px bg-border-subtle" />

        {/* Focus on selected */}
        {appSelectedNode && (
          <button
            onClick={handleFocusSelected}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-accent/30 bg-accent/20 text-accent transition-colors hover:bg-accent/30"
            title="Focus on Selected Node"
          >
            <Focus className="h-4 w-4" />
          </button>
        )}

        {/* Clear selection */}
        {rendererSelectedNode && (
          <button
            onClick={handleClearSelection}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            title="Clear Selection"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}

        {is3DMode && (
          <>
            {/* Divider */}
            <div className="my-1 h-px bg-border-subtle" />

            {/* Camera mode (3D only) */}
            <button
              onClick={() => setCameraMode('arcball')}
              className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
                cameraMode === 'arcball'
                  ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                  : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
              }`}
              title="Arcball Camera"
              data-testid="graph-camera-arcball"
            >
              <Orbit className="h-4 w-4" />
            </button>
            <button
              onClick={() => setCameraMode('firstPerson')}
              className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
                cameraMode === 'firstPerson'
                  ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                  : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
              }`}
              title="First-Person Camera"
              data-testid="graph-camera-firstperson"
            >
              <Navigation className="h-4 w-4" />
            </button>
          </>
        )}

        {/* Divider */}
        <div className="my-1 h-px bg-border-subtle" />

        {/* Layout control */}
        <button
          onClick={isLayoutRunning ? stopLayout : startLayout}
          className={`flex h-9 w-9 items-center justify-center rounded-md border transition-all ${
            isLayoutRunning
              ? 'animate-pulse border-accent bg-accent text-white shadow-glow'
              : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
          } `}
          title={isLayoutRunning ? 'Stop Layout' : 'Run Layout Again'}
        >
          {isLayoutRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
      </div>

      {/* Layout running indicator */}
      {isLayoutRunning && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/20 px-3 py-1.5 backdrop-blur-sm">
          <div className="h-2 w-2 animate-ping rounded-full bg-emerald-400" />
          <span className="text-xs font-medium text-emerald-400">Layout optimizing...</span>
        </div>
      )}

      {/* Query FAB */}
      <QueryFAB />

      {/* AI Highlights toggle - Top Right */}
      <div className="absolute top-4 right-4 z-20">
        <button
          onClick={handleToggleAIHighlights}
          className={
            isAIHighlightsEnabled
              ? 'flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-500/15 text-cyan-200 transition-colors hover:border-cyan-300/60 hover:bg-cyan-500/20'
              : 'flex h-10 w-10 items-center justify-center rounded-lg border border-border-subtle bg-elevated text-text-muted transition-colors hover:bg-hover hover:text-text-primary'
          }
          title={isAIHighlightsEnabled ? 'Turn off all highlights' : 'Turn on AI highlights'}
          data-testid="ai-highlights-toggle"
        >
          {isAIHighlightsEnabled ? (
            <Lightbulb className="h-4 w-4" />
          ) : (
            <LightbulbOff className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
});

GraphCanvas.displayName = 'GraphCanvas';

import { createContext, useContext, useCallback, useMemo, useState, ReactNode } from 'react';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../core/graph/types';
import { DEFAULT_VISIBLE_LABELS, DEFAULT_VISIBLE_EDGES, type EdgeType } from '../../lib/constants';
import { normalizeFolderRenderPath } from '../../lib/folder-render-filter';

interface GraphStateContextValue {
  graph: KnowledgeGraph | null;
  setGraph: (graph: KnowledgeGraph | null) => void;
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;
  visibleLabels: NodeLabel[];
  setVisibleLabels: (labels: NodeLabel[]) => void;
  toggleLabelVisibility: (label: NodeLabel) => void;
  visibleEdgeTypes: EdgeType[];
  setVisibleEdgeTypes: (edgeTypes: EdgeType[]) => void;
  toggleEdgeVisibility: (edgeType: EdgeType) => void;
  depthFilter: number | null;
  setDepthFilter: (depth: number | null) => void;
  highlightedNodeIds: Set<string>;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  excludedFolderPaths: Set<string>;
  setExcludedFolderPaths: (paths: Set<string>) => void;
  toggleFolderRenderExclusion: (path: string) => void;
  clearFolderRenderExclusions: () => void;
}

const GraphStateContext = createContext<GraphStateContextValue | null>(null);

export const GraphStateProvider = ({ children }: { children: ReactNode }) => {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [visibleLabels, setVisibleLabels] = useState<NodeLabel[]>(DEFAULT_VISIBLE_LABELS);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<EdgeType[]>(DEFAULT_VISIBLE_EDGES);
  const [depthFilter, setDepthFilter] = useState<number | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [excludedFolderPaths, setExcludedFolderPaths] = useState<Set<string>>(new Set());

  const toggleLabelVisibility = useCallback((label: NodeLabel) => {
    setVisibleLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );
  }, []);

  const toggleEdgeVisibility = useCallback((edgeType: EdgeType) => {
    setVisibleEdgeTypes((prev) =>
      prev.includes(edgeType) ? prev.filter((e) => e !== edgeType) : [...prev, edgeType],
    );
  }, []);

  const toggleFolderRenderExclusion = useCallback((path: string) => {
    const normalizedPath = normalizeFolderRenderPath(path);
    if (!normalizedPath) return;

    setExcludedFolderPaths((prev) => {
      const next = new Set(prev);
      if (next.has(normalizedPath)) {
        next.delete(normalizedPath);
      } else {
        next.add(normalizedPath);
      }
      return next;
    });
  }, []);

  const clearFolderRenderExclusions = useCallback(() => {
    setExcludedFolderPaths(new Set());
  }, []);

  const value = useMemo<GraphStateContextValue>(
    () => ({
      graph,
      setGraph,
      selectedNode,
      setSelectedNode,
      visibleLabels,
      setVisibleLabels,
      toggleLabelVisibility,
      visibleEdgeTypes,
      setVisibleEdgeTypes,
      toggleEdgeVisibility,
      depthFilter,
      setDepthFilter,
      highlightedNodeIds,
      setHighlightedNodeIds,
      excludedFolderPaths,
      setExcludedFolderPaths,
      toggleFolderRenderExclusion,
      clearFolderRenderExclusions,
    }),
    [
      graph,
      selectedNode,
      visibleLabels,
      visibleEdgeTypes,
      depthFilter,
      highlightedNodeIds,
      excludedFolderPaths,
      toggleFolderRenderExclusion,
      clearFolderRenderExclusions,
    ],
  );

  return <GraphStateContext.Provider value={value}>{children}</GraphStateContext.Provider>;
};

export const useGraphState = (): GraphStateContextValue => {
  const ctx = useContext(GraphStateContext);
  if (!ctx) {
    throw new Error('useGraphState must be used within a GraphStateProvider');
  }
  return ctx;
};

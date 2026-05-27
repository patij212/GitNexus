import type { GraphNode } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../core/graph/graph';
import type { KnowledgeGraph } from '../core/graph/types';

export const normalizeFolderRenderPath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

const normalizeExcludedFolderPaths = (folderPaths: ReadonlySet<string>): Set<string> => {
  const normalized = new Set<string>();
  folderPaths.forEach((path) => {
    const next = normalizeFolderRenderPath(path);
    if (next) normalized.add(next);
  });
  return normalized;
};

export const isPathExcludedByFolder = (
  path: string | undefined,
  excludedFolderPaths: ReadonlySet<string>,
): boolean => {
  if (!path || excludedFolderPaths.size === 0) return false;

  const normalizedPath = normalizeFolderRenderPath(path);
  if (!normalizedPath) return false;

  for (const folderPath of excludedFolderPaths) {
    const normalizedFolderPath = normalizeFolderRenderPath(folderPath);
    if (!normalizedFolderPath) continue;
    if (
      normalizedPath === normalizedFolderPath ||
      normalizedPath.startsWith(`${normalizedFolderPath}/`)
    ) {
      return true;
    }
  }

  return false;
};

export const isGraphNodeExcludedByFolder = (
  node: GraphNode,
  excludedFolderPaths: ReadonlySet<string>,
): boolean => isPathExcludedByFolder(node.properties.filePath, excludedFolderPaths);

export const filterKnowledgeGraphForRendering = (
  graph: KnowledgeGraph,
  excludedFolderPaths: ReadonlySet<string>,
): KnowledgeGraph => {
  const normalizedExcludedPaths = normalizeExcludedFolderPaths(excludedFolderPaths);
  if (normalizedExcludedPaths.size === 0) return graph;

  const filteredGraph = createKnowledgeGraph();
  const includedNodeIds = new Set<string>();

  graph.nodes.forEach((node) => {
    if (isGraphNodeExcludedByFolder(node, normalizedExcludedPaths)) return;
    filteredGraph.addNode(node);
    includedNodeIds.add(node.id);
  });

  graph.relationships.forEach((relationship) => {
    if (
      !includedNodeIds.has(relationship.sourceId) ||
      !includedNodeIds.has(relationship.targetId)
    ) {
      return;
    }
    filteredGraph.addRelationship(relationship);
  });

  return filteredGraph;
};

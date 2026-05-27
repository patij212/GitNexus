import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import { FileTreePanel } from '../../src/components/FileTreePanel';
import { createFileNode } from '../fixtures/graph';

const { appState } = vi.hoisted(() => ({
  appState: {
    graph: null as ReturnType<typeof createKnowledgeGraph> | null,
    visibleLabels: ['Folder', 'File'] as NodeLabel[],
    setVisibleLabels: vi.fn(),
    toggleLabelVisibility: vi.fn(),
    visibleEdgeTypes: ['CONTAINS'],
    setVisibleEdgeTypes: vi.fn(),
    toggleEdgeVisibility: vi.fn(),
    selectedNode: null as GraphNode | null,
    setSelectedNode: vi.fn(),
    openCodePanel: vi.fn(),
    depthFilter: null as number | null,
    setDepthFilter: vi.fn(),
    excludedFolderPaths: new Set<string>(),
    toggleFolderRenderExclusion: vi.fn(),
  },
}));

vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => appState,
}));

const createFolderNode = (path: string): GraphNode => ({
  id: `Folder:${path}`,
  label: 'Folder',
  properties: {
    name: path.split('/').pop() ?? path,
    filePath: path,
  },
});

describe('FileTreePanel folder render toggles', () => {
  afterEach(() => {
    appState.graph = null;
    appState.selectedNode = null;
    appState.excludedFolderPaths = new Set();
    appState.setSelectedNode.mockClear();
    appState.openCodePanel.mockClear();
    appState.toggleFolderRenderExclusion.mockClear();
  });

  it('toggles a folder subtree out of graph rendering from the file tree', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(createFolderNode('src'));
    graph.addNode(createFolderNode('src/ui'));
    graph.addNode(createFileNode('Button.tsx', 'src/ui/Button.tsx'));
    appState.graph = graph;

    const { rerender } = render(<FileTreePanel onFocusNode={vi.fn()} />);

    fireEvent.click(screen.getByTitle('Exclude src from graph rendering'));
    expect(appState.toggleFolderRenderExclusion).toHaveBeenCalledWith('src');

    appState.excludedFolderPaths = new Set(['src']);
    rerender(<FileTreePanel onFocusNode={vi.fn()} />);

    expect(screen.getByTitle('Include src in graph rendering')).toBeInTheDocument();
  });
});

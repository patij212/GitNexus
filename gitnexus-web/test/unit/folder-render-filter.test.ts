import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph';
import {
  filterKnowledgeGraphForRendering,
  isPathExcludedByFolder,
} from '../../src/lib/folder-render-filter';
import {
  createCallsRelationship,
  createClassNode,
  createContainsRelationship,
  createFileNode,
  createFunctionNode,
} from '../fixtures/graph';
import type { GraphNode } from 'gitnexus-shared';

const createFolderNode = (path: string): GraphNode => ({
  id: `Folder:${path}`,
  label: 'Folder',
  properties: {
    name: path.split('/').pop() ?? path,
    filePath: path,
  },
});

describe('folder render exclusion', () => {
  it('matches folders and descendants without matching same-prefix siblings', () => {
    const excluded = new Set(['src/ui']);

    expect(isPathExcludedByFolder('src/ui', excluded)).toBe(true);
    expect(isPathExcludedByFolder('src/ui/Button.tsx', excluded)).toBe(true);
    expect(isPathExcludedByFolder('src/ui/nested/Card.tsx', excluded)).toBe(true);
    expect(isPathExcludedByFolder('src/ui-kit/Button.tsx', excluded)).toBe(false);
    expect(isPathExcludedByFolder('src/utils.ts', excluded)).toBe(false);
  });

  it('filters excluded folder subtrees from the render graph and drops touching edges', () => {
    const graph = createKnowledgeGraph();
    const srcFolder = createFolderNode('src');
    const uiFolder = createFolderNode('src/ui');
    const uiFile = createFileNode('Button.tsx', 'src/ui/Button.tsx');
    const uiClass = createClassNode('Button', 'src/ui/Button.tsx');
    const keptFile = createFileNode('server.ts', 'src/server.ts');
    const keptFunction = createFunctionNode('handler', 'src/server.ts', 4);
    const siblingFile = createFileNode('Button.tsx', 'src/ui-kit/Button.tsx');

    [srcFolder, uiFolder, uiFile, uiClass, keptFile, keptFunction, siblingFile].forEach((node) =>
      graph.addNode(node),
    );

    graph.addRelationship(createContainsRelationship(srcFolder.id, uiFolder.id));
    graph.addRelationship(createContainsRelationship(uiFolder.id, uiFile.id));
    graph.addRelationship(createContainsRelationship(uiFile.id, uiClass.id));
    graph.addRelationship(createContainsRelationship(keptFile.id, keptFunction.id));
    graph.addRelationship(createCallsRelationship(keptFunction.id, uiClass.id));

    const filtered = filterKnowledgeGraphForRendering(graph, new Set(['src/ui']));

    expect(filtered.nodes.map((node) => node.id).sort()).toEqual(
      [srcFolder.id, keptFile.id, keptFunction.id, siblingFile.id].sort(),
    );
    expect(filtered.relationships.map((rel) => rel.id).sort()).toEqual([
      `${keptFile.id}_CONTAINS_${keptFunction.id}`,
    ]);
  });
});

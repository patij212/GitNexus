import type { NodeLabel } from 'gitnexus-shared';

/**
 * Architectural-depth strata for the 3D graph's Z axis.
 *
 * Historically the 3D view scattered nodes on Z by a hash of their id, so the
 * third dimension carried no information — it was a 2D graph floating in noise.
 * These levels map each node kind to a layer of the software hierarchy
 * (0 = outermost container, higher = finer-grained symbol), turning Z into a
 * readable "architectural depth": Project/Package at the front, files and types
 * in the middle, methods and fields at the back.
 *
 * Consumed by `depthMode: 'layered'` to seed each node's initial Z and to target
 * the 3D force layout's Z force (see `graph-render-model` + `useThreeGraph`).
 * `depthMode: 'organic'` (the default) ignores this module entirely and
 * preserves the original hash-scatter behavior.
 */
const NODE_DEPTH_LEVEL: Partial<Record<NodeLabel, number>> = {
  Project: 0,
  Package: 1,
  Module: 2,
  Namespace: 2,
  Folder: 3,
  File: 4,
  // Type-like containers
  Class: 5,
  Interface: 5,
  Struct: 5,
  Trait: 5,
  Enum: 5,
  Union: 5,
  Record: 5,
  Type: 5,
  TypeAlias: 5,
  Template: 5,
  Delegate: 5,
  Impl: 5,
  Section: 5,
  // Callables
  Constructor: 6,
  Method: 6,
  Function: 6,
  Macro: 6,
  // Members / leaves
  Property: 7,
  Variable: 7,
  Const: 7,
  Static: 7,
  Typedef: 7,
  Decorator: 7,
  Annotation: 7,
  Import: 7,
};

/** Deepest stratum index; Z is normalized against this. */
export const MAX_DEPTH_LEVEL = 7;

/**
 * Nodes outside the structural hierarchy (metadata, runtime, unknown kinds) sit
 * on the middle (File) plane rather than collapsing onto the front layer.
 */
const DEFAULT_DEPTH_LEVEL = 4;

/** Architectural-hierarchy level for a node kind (0 = outermost container). */
export const getNodeDepthLevel = (label: NodeLabel): number =>
  NODE_DEPTH_LEVEL[label] ?? DEFAULT_DEPTH_LEVEL;

/**
 * Map a depth level to a Z coordinate centered on 0. Level 0 → +half the spread
 * (front), the deepest level → -half (back), evenly spaced between. Levels are
 * clamped so out-of-range inputs stay on the outermost/innermost plane.
 */
export const depthLevelToZ = (level: number, zSpread: number): number => {
  const clamped = Math.min(MAX_DEPTH_LEVEL, Math.max(0, level));
  return (0.5 - clamped / MAX_DEPTH_LEVEL) * zSpread;
};

/**
 * Half the spacing between adjacent strata — used to jitter nodes within a layer
 * so a stratum reads as a thick band rather than a perfectly flat plane.
 */
export const depthStratumGap = (zSpread: number): number => zSpread / (MAX_DEPTH_LEVEL + 1);

import type { NodeLabel } from 'gitnexus-shared';

/**
 * Level-of-detail labelling for the 3D graph.
 *
 * Rendering a label for every node is unreadable and slow, so the 3D view shows
 * labels for only the most "label-worthy" nodes near the camera. This module is
 * the pure scoring/selection core; `useThreeGraph` feeds it per-node importance
 * and camera distance each tick and renders CSS2D labels for the winners.
 *
 * Importance favours architectural containers over leaves (you want to read
 * "Package auth" from across the graph, not every local variable), amplified by
 * graph degree so hubs surface. Distance then attenuates importance so the set
 * adapts as you fly through the scene (LOD).
 */
const TYPE_IMPORTANCE: Partial<Record<NodeLabel, number>> = {
  Project: 100,
  Package: 80,
  Namespace: 60,
  Module: 60,
  Folder: 40,
  File: 22,
  Class: 18,
  Interface: 18,
  Struct: 18,
  Trait: 16,
  Enum: 14,
  Union: 14,
  Record: 14,
  Constructor: 8,
  Method: 7,
  Function: 7,
  Macro: 7,
  Property: 4,
  Variable: 4,
  Const: 4,
  Static: 4,
};

const DEFAULT_IMPORTANCE = 6;

/**
 * Static label-worthiness of a node (before distance): kind weight amplified by
 * graph degree, so a heavily-referenced function can out-rank a lonely folder.
 */
export const labelImportance = (nodeType: NodeLabel, degree: number): number => {
  const base = TYPE_IMPORTANCE[nodeType] ?? DEFAULT_IMPORTANCE;
  const safeDegree = degree > 0 ? degree : 0;
  return base * (1 + Math.log1p(safeDegree) * 0.5);
};

export interface LabelCandidate {
  index: number;
  importance: number;
  distanceSq: number;
}

/**
 * Pick the `maxLabels` most label-worthy node indices, scoring importance
 * attenuated by camera distance (closer + more important wins). Deterministic:
 * ties break by index so the label set is stable frame-to-frame (no flicker).
 */
export const selectLabelIndices = (
  candidates: readonly LabelCandidate[],
  maxLabels: number,
): number[] => {
  if (maxLabels <= 0 || candidates.length === 0) return [];
  const scored = candidates.map((candidate) => ({
    index: candidate.index,
    score: candidate.importance / Math.sqrt(Math.max(1, candidate.distanceSq)),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, maxLabels).map((entry) => entry.index);
};

/** Trim a symbol name for on-screen display so long names don't dominate. */
export const truncateLabel = (text: string, max = 28): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
};

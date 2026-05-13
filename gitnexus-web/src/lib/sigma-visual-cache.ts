export type TimedVisualAnimation = {
  type: string;
  startTime: number;
  duration: number;
};

export interface ActiveAnimationSnapshot<T extends TimedVisualAnimation> {
  animations: Map<string, T>;
  hasActiveAnimations: boolean;
  signature: string;
}

export const createStableCollectionSignature = (
  values: Iterable<string> | null | undefined,
): string => {
  const items = Array.from(values ?? []);
  if (items.length === 0) return '0:[]';

  items.sort();
  return `${items.length}:${JSON.stringify(items)}`;
};

const createAnimationSnapshotSignature = <T extends TimedVisualAnimation>(
  entries: Array<[string, T]>,
): string => {
  if (entries.length === 0) return '0:[]';

  return `${entries.length}:${JSON.stringify(
    entries.map(([nodeId, animation]) => [
      nodeId,
      animation.type,
      animation.startTime,
      animation.duration,
    ]),
  )}`;
};

export const createActiveAnimationSnapshot = <T extends TimedVisualAnimation>(
  animations: ReadonlyMap<string, T> | null | undefined,
  now: number,
): ActiveAnimationSnapshot<T> => {
  const activeEntries: Array<[string, T]> = [];

  animations?.forEach((animation, nodeId) => {
    const endsAt = animation.startTime + Math.max(0, animation.duration);
    if (now <= endsAt) {
      activeEntries.push([nodeId, animation]);
    }
  });

  activeEntries.sort(([leftNodeId], [rightNodeId]) => leftNodeId.localeCompare(rightNodeId));

  return {
    animations: new Map(activeEntries),
    hasActiveAnimations: activeEntries.length > 0,
    signature: createAnimationSnapshotSignature(activeEntries),
  };
};

export const createAnimationCacheKey = (
  animation: TimedVisualAnimation,
  frameVersion: number,
): string => `${frameVersion}:${animation.type}:${animation.startTime}:${animation.duration}`;

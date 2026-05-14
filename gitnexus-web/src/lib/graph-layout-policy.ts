export const THREE_LAYOUT_POSITION_PUBLISH_INTERVAL_MS = 50;

export const shouldPublishThreeLayoutPositions = (
  nowMs: number,
  lastPublishedAtMs: number | null,
  intervalMs = THREE_LAYOUT_POSITION_PUBLISH_INTERVAL_MS,
): boolean => {
  return lastPublishedAtMs === null || nowMs - lastPublishedAtMs >= intervalMs;
};

export type NoverlapSettings = {
  maxIterations: number;
  ratio: number;
  margin: number;
  expansion: number;
};

export type NoverlapPolicy =
  | { mode: 'skip'; label: string }
  | { mode: 'sync' | 'defer'; label: string; settings: NoverlapSettings };

export const getNoverlapSettings = (nodeCount: number): NoverlapSettings => ({
  maxIterations: nodeCount > 10000 ? 18 : nodeCount > 5000 ? 28 : nodeCount > 2000 ? 55 : 80,
  ratio: nodeCount > 5000 ? 1.04 : 1.1,
  margin: nodeCount > 5000 ? 6 : 10,
  expansion: 1.05,
});

export const getNoverlapPolicy = (nodeCount: number): NoverlapPolicy => {
  if (nodeCount <= 1) return { mode: 'skip', label: 'skip:single-node' };
  if (nodeCount > 15000) return { mode: 'skip', label: 'skip:huge' };

  const settings = getNoverlapSettings(nodeCount);
  const label = `${nodeCount > 5000 ? 'large' : 'standard'}:${settings.maxIterations}`;

  return nodeCount > 5000
    ? { mode: 'defer', label: `defer:${label}`, settings }
    : { mode: 'sync', label: `sync:${label}`, settings };
};

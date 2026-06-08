import { describe, it, expect } from 'vitest';
import {
  MAX_DEPTH_LEVEL,
  depthLevelToZ,
  depthStratumGap,
  getNodeDepthLevel,
} from '../../src/lib/graph-depth';

describe('graph-depth', () => {
  describe('getNodeDepthLevel', () => {
    it('orders kinds from outermost container to finest symbol', () => {
      expect(getNodeDepthLevel('Project')).toBeLessThan(getNodeDepthLevel('Package'));
      expect(getNodeDepthLevel('Package')).toBeLessThan(getNodeDepthLevel('Folder'));
      expect(getNodeDepthLevel('Folder')).toBeLessThan(getNodeDepthLevel('File'));
      expect(getNodeDepthLevel('File')).toBeLessThan(getNodeDepthLevel('Class'));
      expect(getNodeDepthLevel('Class')).toBeLessThan(getNodeDepthLevel('Method'));
      expect(getNodeDepthLevel('Method')).toBeLessThan(getNodeDepthLevel('Property'));
    });

    it('puts Project at the outermost level (0) and leaf members at the deepest', () => {
      expect(getNodeDepthLevel('Project')).toBe(0);
      expect(getNodeDepthLevel('Property')).toBe(MAX_DEPTH_LEVEL);
    });

    it('falls back to a middle level for non-structural kinds', () => {
      const fallback = getNodeDepthLevel('Process');
      expect(fallback).toBeGreaterThan(0);
      expect(fallback).toBeLessThan(MAX_DEPTH_LEVEL);
    });
  });

  describe('depthLevelToZ', () => {
    it('maps level 0 to the front (+half spread) and the deepest to the back (-half)', () => {
      const zSpread = 1000;
      expect(depthLevelToZ(0, zSpread)).toBeCloseTo(zSpread * 0.5);
      expect(depthLevelToZ(MAX_DEPTH_LEVEL, zSpread)).toBeCloseTo(-zSpread * 0.5);
    });

    it('is strictly decreasing as depth increases', () => {
      const zSpread = 500;
      let previous = Number.POSITIVE_INFINITY;
      for (let level = 0; level <= MAX_DEPTH_LEVEL; level += 1) {
        const z = depthLevelToZ(level, zSpread);
        expect(z).toBeLessThan(previous);
        previous = z;
      }
    });

    it('clamps out-of-range levels onto the end planes', () => {
      const zSpread = 200;
      expect(depthLevelToZ(-5, zSpread)).toBe(depthLevelToZ(0, zSpread));
      expect(depthLevelToZ(MAX_DEPTH_LEVEL + 5, zSpread)).toBe(
        depthLevelToZ(MAX_DEPTH_LEVEL, zSpread),
      );
    });
  });

  it('depthStratumGap is positive and narrower than the full spread', () => {
    expect(depthStratumGap(800)).toBeGreaterThan(0);
    expect(depthStratumGap(800)).toBeLessThan(800);
  });
});

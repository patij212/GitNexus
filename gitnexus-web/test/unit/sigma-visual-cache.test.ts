import { describe, expect, it } from 'vitest';
import {
  createActiveAnimationSnapshot,
  createAnimationCacheKey,
  createStableCollectionSignature,
} from '../../src/lib/sigma-visual-cache';

describe('sigma visual cache helpers', () => {
  it('creates stable collection signatures independent of insertion order', () => {
    const first = createStableCollectionSignature(new Set(['node:b', 'node:a']));
    const second = createStableCollectionSignature(new Set(['node:a', 'node:b']));

    expect(first).toBe(second);
    expect(first).toContain('node:a');
    expect(createStableCollectionSignature(new Set())).toBe('0:[]');
  });

  it('keeps only animations that have not expired', () => {
    const animations = new Map([
      ['node:active', { type: 'pulse', startTime: 100, duration: 50 }],
      ['node:expired', { type: 'ripple', startTime: 100, duration: 49 }],
    ]);

    const snapshot = createActiveAnimationSnapshot(animations, 150);

    expect(snapshot.hasActiveAnimations).toBe(true);
    expect([...snapshot.animations.keys()]).toEqual(['node:active']);
    expect(snapshot.signature).toContain('node:active');
    expect(snapshot.signature).not.toContain('node:expired');
  });

  it('changes animation cache keys by frame and animation identity', () => {
    const animation = { type: 'glow', startTime: 25, duration: 4000 };

    expect(createAnimationCacheKey(animation, 1)).not.toBe(createAnimationCacheKey(animation, 2));
    expect(createAnimationCacheKey(animation, 2)).toBe('2:glow:25:4000');
  });
});

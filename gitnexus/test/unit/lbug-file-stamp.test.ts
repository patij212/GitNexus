import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSameDbFileStamp, readDbFileStamp } from '../../src/core/lbug/lbug-adapter.js';

const tempDirs: string[] = [];

describe('LadybugDB file stamp helpers', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('readDbFileStamp includes ctimeMs so rewritten DB files can be detected', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-stamp-'));
    tempDirs.push(dir);

    const dbPath = path.join(dir, 'graph.lbug');
    await fs.writeFile(dbPath, 'seed');

    const stamp = await readDbFileStamp(dbPath);

    expect(stamp).toEqual(
      expect.objectContaining({
        size: 4,
        mtimeMs: expect.any(Number),
        ctimeMs: expect.any(Number),
      }),
    );
  });

  it('treats ctime-only changes as a different DB file stamp', () => {
    expect(
      isSameDbFileStamp(
        { size: 1024, mtimeMs: 10_000, ctimeMs: 20_000 },
        { size: 1024, mtimeMs: 10_000, ctimeMs: 20_001 },
      ),
    ).toBe(false);
  });
});

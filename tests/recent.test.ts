import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

type Recent = { path: string; name: string; openedAt: number; preview: string | null; pinned?: boolean };
type Store = {
  list(): Promise<Recent[]>;
  record(filePath: string, modifiedAt: number): Promise<void>;
  setPreview(filePath: string, preview: string): Promise<void>;
  pin(filePath: string, pinned: boolean): Promise<void>;
  remove(filePath: string): Promise<void>;
};
const require = createRequire(import.meta.url);
const { createRecentStore } = require('../electron/recent.cjs') as { createRecentStore(dir: string): Store };

test('recent PDFs persist in order, keep previews, and skip missing files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'asterpdf-recent-test-'));
  try {
    const first = path.join(directory, 'first.pdf');
    const second = path.join(directory, 'second.pdf');
    await writeFile(first, '%PDF-1.7');
    await writeFile(second, '%PDF-1.7');
    const store = createRecentStore(directory);
    await store.record(first, (await stat(first)).mtimeMs);
    await store.setPreview(first, 'data:image/jpeg;base64,YQ==');
    await store.record(second, (await stat(second)).mtimeMs);
    await store.record(first, (await stat(first)).mtimeMs);
    const reopened = createRecentStore(directory);
    assert.deepEqual((await reopened.list()).map((entry) => entry.name), ['first.pdf', 'second.pdf']);
    assert.equal((await reopened.list())[0].preview, 'data:image/jpeg;base64,YQ==');
    await rm(second);
    assert.deepEqual((await reopened.list()).map((entry) => entry.name), ['first.pdf']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pinned documents persist beyond recent history and removal leaves the file intact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'asterpdf-recent-pins-'));
  try {
    const store = createRecentStore(directory);
    const pinned = path.join(directory, 'pinned.pdf');
    await writeFile(pinned, '%PDF-1.7');
    await store.record(pinned, (await stat(pinned)).mtimeMs);
    await store.pin(pinned, true);
    for (let index = 0; index < 35; index++) {
      const file = path.join(directory, `${index}.pdf`);
      await writeFile(file, '%PDF-1.7');
      await store.record(file, (await stat(file)).mtimeMs);
    }
    const reopened = createRecentStore(directory);
    assert.equal((await reopened.list()).length, 33);
    assert.equal((await reopened.list()).find(item => item.path === pinned)?.pinned, true);
    await reopened.record(pinned, (await stat(pinned)).mtimeMs);
    assert.equal((await reopened.list()).find(item => item.path === pinned)?.pinned, true);
    await reopened.pin(pinned, false);
    assert.equal((await reopened.list()).find(item => item.path === pinned)?.pinned, false);
    await reopened.remove(pinned);
    assert.equal((await reopened.list()).some(item => item.path === pinned), false);
    assert.equal((await stat(pinned)).isFile(), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

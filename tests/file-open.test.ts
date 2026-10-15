import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pdfPathsFromArguments, createFileOpenQueue } = require('../electron/file-open.cjs');

test('launch arguments preserve spaces, Unicode, casing and resolve against the launching directory', () => {
  assert.deepEqual(pdfPathsFromArguments(['AsterPDF.exe', '--updated', '--user-data-dir=C:\\fake.pdf', 'C:\\Docs\\عرض جديد.PDF', 'relative.pdf'],
    { packaged: true, cwd: 'D:\\Work', platform: 'win32' }), ['C:\\Docs\\عرض جديد.PDF', 'D:\\Work\\relative.pdf']);
  assert.deepEqual(pdfPathsFromArguments(['electron', 'test-entry.pdf', '--inspect', '"C:\\Docs\\two words.pdf"', 'https://example.com/test.pdf', 'image.png'],
    { packaged: false, cwd: 'C:\\Work', platform: 'win32' }), ['C:\\Docs\\two words.pdf']);
  assert.deepEqual(pdfPathsFromArguments(['AsterPDF', '/Users/me/عرض جديد.pdf', 'local.pdf'],
    { packaged: true, cwd: '/Users/me', platform: 'darwin' }), ['/Users/me/عرض جديد.pdf', '/Users/me/local.pdf']);
});

test('OS requests wait for renderer readiness, serialize, deduplicate and survive a window reload', () => {
  const delivered: { id: string; path: string }[] = [];
  const queue = createFileOpenQueue({ platform: 'win32', send: (value: { id: string; path: string }) => delivered.push(value) });
  assert.equal(queue.enqueue('C:\\Docs\\one.pdf'), true);
  assert.equal(queue.enqueue('c:\\docs\\ONE.PDF'), true);
  assert.equal(queue.enqueue('C:\\Docs\\two.pdf'), true);
  assert.equal(queue.enqueue('relative.pdf'), false);
  assert.equal(queue.enqueue('C:\\Docs\\app.exe'), false);
  assert.equal(delivered.length, 0);
  queue.setReady(true); assert.equal(delivered.length, 1);
  queue.complete('wrong-id'); assert.equal(delivered.length, 1);
  queue.reset(); queue.setReady(true);
  assert.equal(delivered[1].id, delivered[0].id);
  queue.complete(delivered[1].id);
  assert.equal(delivered[2].path, 'C:\\Docs\\two.pdf');
  queue.complete(delivered[2].id);
  queue.enqueue('C:\\Docs\\one.pdf'); assert.equal(delivered.length, 4);
});

test('Mac file requests keep case-sensitive paths distinct', () => {
  const delivered: { id: string; path: string }[] = [];
  const queue = createFileOpenQueue({ platform: 'darwin', send: (value: { id: string; path: string }) => delivered.push(value) });
  queue.enqueue('/Users/me/A.pdf'); queue.enqueue('/Users/me/a.pdf'); queue.setReady(true);
  queue.complete(delivered[0].id);
  assert.equal(delivered.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ReleaseProvider, selectPackage } = require('../electron/release-provider.cjs');
const hash = Buffer.alloc(64, 1).toString('base64');
const feedUrl = 'https://github.com/xxmelar-ksaxx/AsterPDF-app/releases/download/v1.2.0/';
const files = ['arm64', 'x64'].map(arch => ({ url: `AsterPDF-1.2.0-macOS-${arch}.zip`, sha512: hash, size: 100 }));
const target = { version: '1.2.0', feedUrl, packageName: files[1].url };

test('pinned provider reads metadata from the selected older release and exposes only the exact architecture', async () => {
  let requested = '';
  const provider = new ReleaseProvider({ target }, { channel: null, isAddNoCacheQuery: false },
    { platform: 'darwin', executor: {} });
  provider.httpRequest = async (url: URL) => {
    requested = url.href;
    return JSON.stringify({ version: '1.2.0', files }); // JSON is valid YAML.
  };
  const info = await provider.getLatestVersion();
  assert.equal(requested, `${feedUrl}latest-mac.yml`);
  assert.deepEqual(info.files, [files[1]]);
  assert.equal(provider.resolveFiles(info)[0].url.href, `${feedUrl}${files[1].url}`);
  assert.deepEqual(selectPackage({ version: '1.2.0', files }, { ...target, packageName: files[0].url }).files, [files[0]]);
});

test('wrong architecture, mismatched versions, missing hashes, and redirected package URLs cannot download', () => {
  assert.throws(() => selectPackage({ version: '1.3.0', files }, target), /version changed/);
  assert.throws(() => selectPackage({ version: '1.2.0', files: [files[0]] }, target), /compatible package/);
  for (const file of [
    { ...files[1], sha512: '' },
    { ...files[1], url: `https://example.com/${files[1].url}` },
    { ...files[1], url: `../v1.3.0/${files[1].url}` },
  ]) assert.throws(() => selectPackage({ version: '1.2.0', files: [file] }, target));
  assert.throws(() => selectPackage({ version: '1.2.0', files: [files[1], files[1]] }, target));
});

test('Windows package selection retains checksum and strips other packages and legacy download paths', () => {
  const name = 'AsterPDF-1.2.0-Windows-x64-Setup.exe';
  const info = selectPackage({ version: '1.2.0', files: [{ url: name, sha512: hash }],
    path: 'wrong.exe', packages: { x64: { path: 'wrong.7z' } } }, { ...target, packageName: name });
  assert.equal(info.path, name);
  assert.equal(info.sha512, hash);
  assert.equal(info.packages, undefined);
});

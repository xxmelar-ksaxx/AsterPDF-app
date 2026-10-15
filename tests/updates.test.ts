import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createUpdateService, parseRelease, selectRelease, fetchRelease, updateArchitecture, INTERVAL } = require('../electron/updates.cjs');
const repo = 'https://github.com/xxmelar-ksaxx/AsterPDF-app';
const release = (version: string) => ({ tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [`AsterPDF-${version}-Windows-x64-Setup.exe`, 'latest.yml', 'latest-mac.yml',
    ...['arm64', 'x64'].flatMap((arch) => ['dmg', 'zip'].map((ext) => `AsterPDF-${version}-macOS-${arch}.${ext}`))].map((name) =>
    ({ name, state: 'uploaded', browser_download_url: `${repo}/releases/download/v${version}/${name}` })) });

test('release parsing picks the correct installer and rejects unexpected download destinations', () => {
  const data = release('1.2.0');
  assert.match(parseRelease(data, 'win32', 'x64').downloadUrl, /Windows-x64-Setup\.exe$/);
  assert.match(parseRelease(data, 'darwin', 'arm64').downloadUrl, /macOS-arm64\.dmg$/);
  assert.match(parseRelease(data, 'darwin', 'x64').downloadUrl, /macOS-x64\.dmg$/);
  assert.equal(parseRelease({ ...data, assets: [] }, 'win32', 'x64').downloadUrl, null);
  data.assets[0].browser_download_url = 'https://example.com/installer.exe';
  assert.equal(parseRelease(data, 'win32', 'x64').downloadUrl, null);
  assert.throws(() => parseRelease({ ...data, prerelease: true }, 'win32', 'x64'), /stable release/);
  assert.throws(() => parseRelease(release('1.2.0-beta.1'), 'win32', 'x64'), /stable release/);
  assert.throws(() => parseRelease(release('../bad'), 'win32', 'x64'), /stable release/);
});

test('checks use semantic versions, persist the 24-hour schedule, and allow manual checks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterpdf-updates-'));
  let now = 1_800_000_000_000, calls = 0, scheduledDelay = 0, next = release('0.9.0');
  const opened: string[] = [];
  const options = { userDataPath: directory, currentVersion: '0.10.0', platform: 'win32', arch: 'x64',
    now: () => now, request: async () => { calls++; return [next]; }, openExternal: async (url: string) => { opened.push(url); },
    setTimer: (_callback: () => void, delay: number) => { scheduledDelay = delay; return { unref() {} }; }, clearTimer: () => {} };
  const service = createUpdateService(options);
  let reopened;
  try {
    assert.equal((await service.check(false)).status, 'current');
    assert.equal(calls, 1); assert.equal(scheduledDelay, INTERVAL);
    service.stop();
    now += 23 * 60 * 60 * 1000;
    reopened = createUpdateService(options);
    await reopened.start(); await reopened.check(false);
    assert.equal(calls, 1); assert.equal(scheduledDelay, 60 * 60 * 1000);
    next = release('0.11.0');
    now += 60 * 60 * 1000;
    const newer = await reopened.check(false);
    assert.equal(calls, 2); assert.equal(newer.available, true);
    await reopened.openUpdate(); assert.match(opened[0], /AsterPDF-0\.11\.0-Windows-x64-Setup\.exe$/);
    next = release('0.10.0');
    assert.equal((await reopened.check(true)).status, 'current');
    assert.equal(calls, 3);
    await assert.rejects(reopened.openUpdate(), /No newer release/);
  } finally { service.stop(); reopened?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent checks share a request and offline failures retain a previously found update', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterpdf-updates-'));
  let calls = 0, finish!: (value: unknown) => void, offline = false;
  const options = { userDataPath: directory, currentVersion: '0.5.0', platform: 'darwin', arch: 'arm64',
    request: async () => { calls++; if (offline) throw new TypeError('fetch failed'); return new Promise((resolve) => { finish = resolve; }); },
    openExternal: async () => {}, setTimer: () => ({ unref() {} }), clearTimer: () => {} };
  const service = createUpdateService(options);
  let reopened;
  try {
    const first = service.check(); const second = service.check();
    assert.equal(first, second);
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
    finish([release('0.6.0')]);
    assert.equal((await first).available, true); assert.equal(calls, 1);
    offline = true;
    const failed = await service.check();
    assert.equal(failed.status, 'error'); assert.equal(failed.available, true); assert.equal(failed.latestVersion, '0.6.0');
    service.stop(); reopened = createUpdateService(options);
    await reopened.start(); const cached = await reopened.check(false);
    assert.equal(calls, 2); assert.equal(cached.available, true); assert.equal(cached.status, 'error');
  } finally { service.stop(); reopened?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a damaged cache is recovered, and an incomplete release does not offer an update', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterpdf-updates-'));
  const opened: string[] = [];
  await writeFile(path.join(directory, 'updates.json'), '{damaged');
  const service = createUpdateService({ userDataPath: directory, currentVersion: '0.5.0', platform: 'win32', arch: 'x64',
    request: async () => [{ ...release('0.6.0'), assets: [] }], openExternal: async (url: string) => { opened.push(url); },
    setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  try {
    assert.equal((await service.check(false)).downloadAvailable, false);
    assert.equal(service.getState().available, false);
    await assert.rejects(service.openUpdate(), /No newer release/);
    assert.equal(opened.length, 0);
  } finally { service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('each architecture finds its newest complete stable release even when newer releases skip it', () => {
  const armOnly = release('1.3.0');
  armOnly.assets = armOnly.assets.filter((asset) => !asset.name.includes('macOS-x64'));
  const incompleteIntel = release('1.4.0');
  incompleteIntel.assets = incompleteIntel.assets.filter((asset) => !asset.name.endsWith('x64.zip'));
  const data = [armOnly, release('1.1.0'), release('1.2.0'), incompleteIntel,
    { ...release('2.0.0'), draft: true }, release('2.0.0-beta.1')];
  assert.equal(selectRelease(data, 'darwin', 'x64').parsed.version, '1.2.0');
  assert.equal(selectRelease(data, 'darwin', 'arm64').parsed.version, '1.4.0');
  assert.equal(selectRelease(data, 'win32', 'x64').parsed.version, '1.4.0');
  assert.equal(selectRelease([armOnly], 'darwin', 'x64'), null);
  const noMetadata = release('1.5.0');
  noMetadata.assets = noMetadata.assets.filter((asset) => asset.name !== 'latest-mac.yml');
  assert.equal(selectRelease([noMetadata], 'darwin', 'x64'), null);
  assert.equal(updateArchitecture('darwin', 'x64', true), 'arm64');
  assert.equal(updateArchitecture('darwin', 'x64', false), 'x64');
  assert.equal(updateArchitecture('win32', 'x64', true), 'x64');
});

test('release discovery paginates beyond a full page of Apple Silicon-only releases', async () => {
  const first = Array.from({ length: 100 }, (_, index) => {
    const item = release(`2.${index}.0`);
    item.assets = item.assets.filter((asset) => !asset.name.includes('macOS-x64'));
    return item;
  });
  const urls: string[] = [];
  const data = await fetchRelease({ fetcher: async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(url.endsWith('page=1') ? first : [release('1.9.0')]));
  } });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /per_page=100&page=2$/);
  assert.equal(selectRelease(data, 'darwin', 'x64').parsed.version, '1.9.0');
  await assert.rejects(fetchRelease({ fetcher: async () => new Response('{}') }), /invalid release/);
  await assert.rejects(fetchRelease({ fetcher: async (url: string) => url.endsWith('page=1')
    ? new Response(JSON.stringify(first)) : new Response('', { status: 403 }) }), /limited update checks/);
});

test('Intel release target is cached across restarts, skipped versions do not prompt or downgrade, and cache is architecture-specific', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterpdf-intel-updates-'));
  const armOnly = release('1.3.0');
  armOnly.assets = armOnly.assets.filter((asset) => !asset.name.includes('macOS-x64'));
  let calls = 0;
  const options = { userDataPath: directory, currentVersion: '1.1.0', platform: 'darwin', arch: 'x64',
    request: async () => { calls++; return [armOnly, release('1.2.0')]; },
    setTimer: () => ({ unref() {} }), clearTimer: () => {} };
  const services: any[] = [];
  const make = (overrides = {}) => { const service = createUpdateService({ ...options, ...overrides }); services.push(service); return service; };
  try {
    const service = make();
    assert.equal((await service.check()).latestVersion, '1.2.0');
    assert.equal(service.getDownloadTarget().feedUrl, `${repo}/releases/download/v1.2.0/`);
    assert.equal(service.getDownloadTarget().packageName, 'AsterPDF-1.2.0-macOS-x64.zip');
    const reopened = make();
    assert.equal((await reopened.check(false)).available, true);
    assert.equal(calls, 1);
    for (const currentVersion of ['1.2.0', '1.4.0']) {
      const current = make({ currentVersion });
      assert.equal((await current.check(false)).available, false);
      assert.throws(() => current.getDownloadTarget(), /No compatible/);
    }
    const arm = make({ arch: 'arm64' });
    assert.equal((await arm.check(false)).latestVersion, '1.3.0');
    assert.equal(calls, 2);
  } finally { services.forEach(service => service.stop()); await rm(directory, { recursive: true, force: true }); }
});

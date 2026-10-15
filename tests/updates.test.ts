import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createUpdateService, parseRelease, INTERVAL } = require('../electron/updates.cjs');
const repo = 'https://github.com/xxmelar-ksaxx/AsterPDF-app';
const release = (version: string) => ({ tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [`AsterPDF-${version}-Windows-x64-Setup.exe`, `AsterPDF-${version}-macOS-arm64.dmg`].map((name) =>
    ({ name, state: 'uploaded', browser_download_url: `${repo}/releases/download/v${version}/${name}` })) });

test('release parsing picks the correct installer and rejects unexpected download destinations', () => {
  const data = release('1.2.0');
  assert.match(parseRelease(data, 'win32', 'x64').downloadUrl, /Windows-x64-Setup\.exe$/);
  assert.match(parseRelease(data, 'darwin', 'arm64').downloadUrl, /macOS-arm64\.dmg$/);
  assert.equal(parseRelease(data, 'darwin', 'x64').downloadUrl, null);
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
    now: () => now, request: async () => { calls++; return next; }, openExternal: async (url: string) => { opened.push(url); },
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
    finish(release('0.6.0'));
    assert.equal((await first).available, true); assert.equal(calls, 1);
    offline = true;
    const failed = await service.check();
    assert.equal(failed.status, 'error'); assert.equal(failed.available, true); assert.equal(failed.latestVersion, '0.6.0');
    service.stop(); reopened = createUpdateService(options);
    await reopened.start(); const cached = await reopened.check(false);
    assert.equal(calls, 2); assert.equal(cached.available, true); assert.equal(cached.status, 'error');
  } finally { service.stop(); reopened?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a stale or damaged cache is recovered, and missing installers open the release page', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterpdf-updates-'));
  const opened: string[] = [];
  await writeFile(path.join(directory, 'updates.json'), '{damaged');
  const service = createUpdateService({ userDataPath: directory, currentVersion: '0.5.0', platform: 'win32', arch: 'x64',
    request: async () => ({ ...release('0.6.0'), assets: [] }), openExternal: async (url: string) => { opened.push(url); },
    setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  try {
    assert.equal((await service.check(false)).downloadAvailable, false);
    await service.openUpdate(); assert.equal(opened[0], `${repo}/releases/tag/v0.6.0`);
  } finally { service.stop(); await rm(directory, { recursive: true, force: true }); }
});

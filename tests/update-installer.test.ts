import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdateInstaller } = require('../electron/update-installer.cjs');
const target = { version: '0.6.0', feedUrl: 'https://github.com/xxmelar-ksaxx/AsterPDF-app/releases/download/v0.6.0/',
  packageName: 'AsterPDF-0.6.0-macOS-x64.zip' };

class Updater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checks = 0;
  installs = 0;
  version = '0.6.0';
  feed: any;
  setFeedURL(value: any) { this.feed = value; }
  checkForUpdates = async () => { this.checks++; return { isUpdateAvailable: true, updateInfo: { version: this.version } }; };
  downloadUpdate: () => Promise<void> = async () => {};
  quitAndInstall(silent: boolean, restart: boolean) { assert.equal(silent, true); assert.equal(restart, true); this.installs++; }
}

test('downloads are explicit, coalesced, report progress, and only verified downloads can install', async () => {
  const updater = new Updater();
  let finish!: () => void;
  updater.downloadUpdate = () => new Promise((resolve) => { finish = resolve; });
  const service = createUpdateInstaller({ updater, isPackaged: true });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.checks, 0);
  assert.throws(() => service.install(), /Download/);
  const pending = service.download(target);
  assert.equal(service.download(target), pending);
  await new Promise((resolve) => setImmediate(resolve));
  updater.emit('download-progress', { percent: 42, transferred: 420, total: 1000 });
  assert.equal(service.getState().percent, 42);
  assert.equal(service.getState().transferred, 420);
  // macOS can emit this before the overall download operation settles.
  updater.emit('update-downloaded', {});
  assert.throws(() => service.install(), /Download/);
  finish(); await pending;
  assert.equal(service.getState().phase, 'ready');
  assert.equal(updater.installs, 0);
  await service.download(target); assert.equal(updater.checks, 1);
  assert.equal(updater.feed.provider, 'custom');
  assert.deepEqual(updater.feed.target, target);
  service.install(); assert.equal(updater.installs, 1);
  assert.throws(() => service.install(), /Download/);
});

test('failed verification blocks installation and a successful retry recovers', async () => {
  const updater = new Updater();
  updater.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
  const service = createUpdateInstaller({ updater, isPackaged: true });
  await service.download(target);
  assert.equal(service.getState().phase, 'error');
  assert.match(service.getState().error, /could not be verified/);
  assert.throws(() => service.install(), /Download/);
  updater.downloadUpdate = async () => {};
  await service.download(target);
  assert.equal(service.getState().phase, 'ready');
  updater.quitAndInstall = () => { updater.emit('error', new Error('installer failed')); };
  service.install(); assert.equal(service.getState().phase, 'error');
});

test('missing metadata, changed releases, and development builds cannot install', async () => {
  const updater = new Updater();
  let downloaded = false;
  updater.downloadUpdate = async () => { downloaded = true; };
  const service = createUpdateInstaller({ updater, isPackaged: true });
  updater.version = '0.7.0';
  await service.download(target);
  assert.equal(downloaded, false); assert.match(service.getState().error, /release changed/);
  updater.checkForUpdates = async () => { throw new Error('404 latest.yml'); };
  await service.download(target);
  assert.match(service.getState().error, /missing its in-app update files/);
  const development = createUpdateInstaller({ updater: new Updater(), isPackaged: false });
  await development.download(target);
  assert.match(development.getState().error, /installed version/);
  assert.throws(() => development.install(), /Download/);
});

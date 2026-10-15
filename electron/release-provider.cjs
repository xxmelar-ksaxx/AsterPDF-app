const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
const { getFileList } = require('electron-updater/out/providers/Provider');

// Pin both the release and package selected by the main-process release check.
// The ordinary GitHub provider always checks the globally latest release, which
// can omit this machine's architecture. GenericProvider keeps updater-managed
// HTTP, checksum verification, caching, and native signature verification.
class ReleaseProvider extends GenericProvider {
  constructor(configuration, updater, runtimeOptions) {
    super({ provider: 'generic', url: configuration.target.feedUrl, channel: 'latest' }, updater,
      { ...runtimeOptions, isUseMultipleRangeRequest: false });
    this.target = configuration.target;
  }

  async getLatestVersion() {
    return selectPackage(await super.getLatestVersion(), this.target);
  }
}

function selectPackage(info, target) {
  if (info?.version !== target.version) throw new Error('Release metadata version changed');
  const expectedUrl = `${target.feedUrl}${encodeURIComponent(target.packageName)}`;
  const files = getFileList(info).filter((file) => {
    try { return new URL(file.url, target.feedUrl).href === expectedUrl; } catch { return false; }
  });
  if (files.length !== 1 || !/^[A-Za-z0-9+/]{86}==$/.test(files[0].sha512 || '')) {
    throw new Error('Release metadata is missing the compatible package or its sha512 checksum');
  }
  // Do not carry legacy paths, web-installer packages, or other-architecture
  // entries into electron-updater, whose fallback can select a different file.
  return { version: info.version, files: [{ ...files[0], url: target.packageName }],
    path: target.packageName, sha512: files[0].sha512, releaseDate: info.releaseDate,
    releaseName: info.releaseName, releaseNotes: info.releaseNotes,
    minimumSystemVersion: info.minimumSystemVersion, stagingPercentage: info.stagingPercentage };
}

module.exports = { ReleaseProvider, selectPackage };

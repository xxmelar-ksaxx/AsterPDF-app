const fs = require('node:fs/promises');
const path = require('node:path');
const semver = require('semver');

const INTERVAL = 24 * 60 * 60 * 1000;
const REPOSITORY = 'https://github.com/xxmelar-ksaxx/AsterPDF-app';
const API_URL = 'https://api.github.com/repos/xxmelar-ksaxx/AsterPDF-app/releases';
const CACHE_VERSION = 2;

async function fetchPage(page, fetcher = fetch) {
  const response = await fetcher(`${API_URL}?per_page=100&page=${page}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AsterPDF-Update-Check' },
    redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (response.status === 404) throw new Error('No published release is available yet.');
  if (response.status === 403 || response.status === 429) throw new Error('GitHub temporarily limited update checks. Try again later.');
  if (!response.ok) throw new Error('GitHub could not provide release information. Try again later.');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('GitHub returned invalid release information.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchRelease({ fetcher = fetch } = {}) {
  const releases = [];
  // Release creation dates need not follow semantic version order. Read every
  // page, rather than assuming the first compatible item is the newest version.
  for (let page = 1; page <= 20; page++) {
    const data = await fetchPage(page, fetcher);
    if (!Array.isArray(data)) throw new Error('GitHub returned invalid release information.');
    releases.push(...data);
    if (data.length < 100) return releases;
  }
  // Never report "up to date" after silently truncating the release history.
  throw new Error('GitHub release history is too large to check completely. Please try again later.');
}

function updateArchitecture(platform, arch, translated = false) {
  return platform === 'darwin' && translated ? 'arm64' : arch;
}

function parseRelease(data, platform, arch) {
  const version = typeof data?.tag_name === 'string' ? semver.valid(data.tag_name) : null;
  if (!version || data.draft !== false || data.prerelease !== false || semver.prerelease(version))
    throw new Error('GitHub did not return a valid stable release.');
  const releaseUrl = `${REPOSITORY}/releases/tag/${encodeURIComponent(data.tag_name)}`;
  const fileName = platform === 'win32' && arch === 'x64' ? `AsterPDF-${version}-Windows-x64-Setup.exe`
    : platform === 'darwin' && ['arm64', 'x64'].includes(arch) ? `AsterPDF-${version}-macOS-${arch}.dmg` : null;
  const feedUrl = `${REPOSITORY}/releases/download/${encodeURIComponent(data.tag_name)}/`;
  const packageName = platform === 'darwin' && fileName ? fileName.replace(/\.dmg$/, '.zip') : fileName;
  const metadataName = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
  const hasAsset = (name) => name && Array.isArray(data.assets) && data.assets.some((item) => item?.name === name &&
    item.state === 'uploaded' && item.browser_download_url === `${feedUrl}${encodeURIComponent(name)}`);
  const compatible = hasAsset(fileName) && hasAsset(packageName) && hasAsset(metadataName);
  return { version, tag: data.tag_name, releaseUrl, feedUrl, packageName,
    downloadUrl: compatible ? `${feedUrl}${encodeURIComponent(fileName)}` : null };
}

function selectRelease(data, platform, arch) {
  if (!Array.isArray(data)) throw new Error('GitHub returned invalid release information.');
  let selected = null;
  for (const item of data) {
    let parsed;
    try { parsed = parseRelease(item, platform, arch); } catch { continue; }
    if (parsed.downloadUrl && (!selected || semver.gt(parsed.version, selected.parsed.version))) selected = { raw: item, parsed };
  }
  return selected;
}

function createUpdateService({ userDataPath, currentVersion, platform = process.platform, arch = process.arch,
  request = fetchRelease, openExternal, onChange = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!semver.valid(currentVersion)) throw new Error('Invalid installed application version.');
  const file = path.join(userDataPath, 'updates.json');
  let lastAttemptAt = null, lastCheckedAt = null, release = null, rawRelease = null;
  let status = 'idle', error = null, pending = null, timer = null, stopped = false;
  const getState = () => ({ status, currentVersion, latestVersion: release?.version || null,
    available: Boolean(release && semver.gt(release.version, currentVersion)),
    downloadAvailable: Boolean(release?.downloadUrl), lastCheckedAt, error });
  const publish = () => onChange(getState());
  const ready = (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved.cacheVersion !== CACHE_VERSION || saved.platform !== platform || saved.arch !== arch) return;
      const validTime = (value) => Number.isFinite(value) && value > 0 && value <= now();
      lastAttemptAt = validTime(saved.lastAttemptAt) ? saved.lastAttemptAt : null;
      lastCheckedAt = validTime(saved.lastCheckedAt) ? saved.lastCheckedAt : null;
      if (saved.release) {
        release = parseRelease(saved.release, platform, arch); rawRelease = saved.release;
        if (!release.downloadUrl) throw new Error('Incomplete cached release');
      }
      if (lastCheckedAt) status = release && semver.gt(release.version, currentVersion) ? 'available' : 'current';
      if (lastAttemptAt && (saved.failed || lastAttemptAt !== lastCheckedAt)) {
        status = 'error'; error = 'The last update check could not finish. Check your connection and try again.';
      }
    } catch { lastAttemptAt = null; lastCheckedAt = null; release = null; rawRelease = null; }
  })();
  async function persist() {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(userDataPath, { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ cacheVersion: CACHE_VERSION, platform, arch,
        lastAttemptAt, lastCheckedAt, release: rawRelease, failed: status === 'error' || status === 'checking' }));
      await fs.rename(temporary, file);
    } catch { /* Checking still works if local cache storage is unavailable. */ }
  }
  function schedule() {
    if (timer) clearTimer(timer);
    if (stopped) return;
    const elapsed = lastAttemptAt === null ? INTERVAL : now() - lastAttemptAt;
    timer = setTimer(() => { void check(false); }, Math.max(1000, INTERVAL - Math.max(0, elapsed)));
    timer?.unref?.();
  }
  function check(force = true) {
    if (pending) return pending;
    pending = (async () => {
      await ready;
      if (!force && lastAttemptAt !== null && now() >= lastAttemptAt && now() - lastAttemptAt < INTERVAL) return getState();
      lastAttemptAt = now(); status = 'checking'; error = null; publish();
      await persist();
      try {
        const data = await request();
        const selected = selectRelease(data, platform, arch);
        // Cache only the release fields used by this feature.
        const parsed = selected?.parsed;
        const names = parsed ? [parsed.downloadUrl.split('/').pop(), parsed.packageName, platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'] : [];
        rawRelease = selected ? { tag_name: selected.raw.tag_name, draft: false, prerelease: false,
          assets: selected.raw.assets.filter((asset) => names.includes(asset.name))
            .map(({ name, state, browser_download_url }) => ({ name, state, browser_download_url })) } : null;
        release = parsed || null; lastCheckedAt = lastAttemptAt;
        status = release && semver.gt(release.version, currentVersion) ? 'available' : 'current';
      } catch (cause) {
        status = 'error';
        error = /^(GitHub|No published)/.test(cause?.message) ? cause.message
          : 'Could not check for updates. Check your connection and try again.';
      }
      await persist(); publish();
      return getState();
    })().finally(() => { pending = null; schedule(); });
    return pending;
  }
  return {
    getState,
    getDownloadTarget() {
      if (!release?.downloadUrl || !semver.gt(release.version, currentVersion)) throw new Error('No compatible update is available.');
      return { ...release, platform, arch };
    },
    async start() { await ready; publish(); void check(false); },
    check,
    async openUpdate() {
      await ready;
      if (!release || !semver.gt(release.version, currentVersion)) throw new Error('No newer release is available. Check for updates first.');
      await openExternal(release.downloadUrl || release.releaseUrl);
    },
    stop() { stopped = true; if (timer) clearTimer(timer); }
  };
}

module.exports = { createUpdateService, parseRelease, selectRelease, fetchRelease, updateArchitecture, INTERVAL, API_URL, CACHE_VERSION };

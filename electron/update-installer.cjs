// electron-updater owns the platform installer, cache, checksum verification,
// and (when configured) code-signature verification. Never execute renderer URLs.
function createUpdateInstaller({ updater, isPackaged, onChange = () => {} }) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // Full downloads give continuous progress and don't require older blockmaps.
  updater.disableDifferentialDownload = true;
  let state = { phase: 'idle', version: null, percent: 0, transferred: 0, total: 0, error: null };
  let pending = null;
  const publish = (patch) => { state = { ...state, ...patch }; onChange(); };
  const fail = (cause) => {
    const detail = String(cause?.message || cause);
    const error = /latest.*yml|404|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(detail)
      ? 'This release is missing its in-app update files. Please try again after the release is completed.'
      : /sha512|checksum|signature|code sign/i.test(detail)
        ? 'The update could not be verified. Nothing was installed. Try downloading again.'
        : /ENOSPC|disk space/i.test(detail) ? 'There is not enough disk space to download the update.'
          : 'The update could not finish. Check your connection and try downloading again.';
    publish({ phase: 'error', error });
  };
  updater.on('error', fail);
  updater.on('download-progress', ({ percent, transferred, total }) => {
    if (state.phase !== 'downloading') return;
    publish({ percent: Math.max(0, Math.min(100, Number(percent) || 0)),
      transferred: Math.max(0, Number(transferred) || 0), total: Math.max(0, Number(total) || 0) });
  });
  return {
    getState: () => ({ ...state }),
    download(version) {
      if (pending) return pending;
      if (state.phase === 'installing' || (state.phase === 'ready' && state.version === version)) return Promise.resolve();
      if (!isPackaged) {
        publish({ phase: 'error', error: 'In-app updates are available in the installed version of AsterPDF. Build and install the app to use this feature.' });
        return Promise.resolve();
      }
      publish({ phase: 'preparing', version, percent: 0, transferred: 0, total: 0, error: null });
      pending = (async () => {
        try {
          const result = await updater.checkForUpdates();
          if (!result?.isUpdateAvailable || result.updateInfo.version !== version) {
            publish({ phase: 'error', error: 'The release changed. Check for updates again before downloading.' });
            return;
          }
          publish({ phase: 'downloading', error: null });
          await updater.downloadUpdate();
          // On macOS this means the ZIP is verified and cached. Native staging
          // is deliberately delayed until the user requests installation.
          if (state.phase !== 'error') publish({ phase: 'ready', percent: 100 });
        } catch (cause) { fail(cause); }
      })().finally(() => { pending = null; });
      return pending;
    },
    install() {
      if (state.phase !== 'ready') throw new Error('Download the update before installing it.');
      publish({ phase: 'installing', error: null });
      try { updater.quitAndInstall(true, true); }
      catch (cause) { fail(cause); }
    }
  };
}

module.exports = { createUpdateInstaller };

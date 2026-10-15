import { Download, RefreshCw } from 'lucide-react';
import type { useUpdates } from '../updates';

export default function UpdateSettings({ updates, onInstall, busy, installError }: {
  updates: ReturnType<typeof useUpdates>; onInstall: () => void; busy: boolean; installError: string;
}) {
  const { state, checking, downloading, error, check, download } = updates;
  const transfer = state?.transfer;
  const ready = transfer?.phase === 'ready';
  const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return <section className="update-settings" aria-labelledby="updates-title">
    <div className="update-settings-heading"><h3 id="updates-title">Updates</h3><span>{state ? `Installed: ${state.currentVersion}` : 'Loading version…'}</span></div>
    <p className="update-status" role="status">{ready ? `Version ${transfer.version} is ready to install.`
      : downloading ? <><span className="inline-spinner" />{transfer?.phase === 'downloading' ? 'Downloading update…' : 'Preparing download…'}</>
      : checking ? <><span className="inline-spinner" />Checking for updates…</>
      : state?.available ? `Version ${state.latestVersion} is available.`
      : state?.status === 'current' ? 'You’re up to date.'
      : state?.status === 'error' ? 'Unable to check for updates.' : 'Check GitHub for the latest version.'}</p>
    {downloading && <div className="update-download-progress">
      <div className={`update-progress-track${transfer?.phase === 'downloading' ? '' : ' is-preparing'}`} role="progressbar" aria-label="Update download progress"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={transfer?.phase === 'downloading' ? transfer.percent : undefined}>
        <span style={{ width: transfer?.phase === 'downloading' ? `${transfer.percent}%` : '30%' }} />
      </div>
      {transfer?.phase === 'downloading' && <span>{Math.floor(transfer.percent)}%{transfer.total > 0 ? ` · ${megabytes(transfer.transferred)} / ${megabytes(transfer.total)}` : ''}</span>}
    </div>}
    {(installError || transfer?.error || error || state?.error) && <p className="update-error" role="alert">{installError || transfer?.error || error || state?.error}</p>}
    <div className="update-settings-actions">
      <button className="button outline" onClick={() => void check()} disabled={checking || downloading || ready || busy}><RefreshCw size={15} />Check for updates</button>
      {ready ? <button className="button primary" onClick={onInstall} disabled={busy}><RefreshCw size={15} />Restart and install</button>
        : state?.available && <button className="button primary" onClick={() => void download()} disabled={downloading || checking || busy}>
          <Download size={15} />{downloading ? 'Downloading…' : transfer?.phase === 'error' ? 'Retry download' : 'Download update'}</button>}
    </div>
    {ready && <p className="update-message">Your unsaved PDF changes will be saved before restarting. Canceling or failing a save keeps AsterPDF open.</p>}
    <p className="update-check-note">Checks automatically every 24 hours while AsterPDF is running, or when you next open it. PDF files stay on your computer.</p>
    {state?.lastCheckedAt && <p className="update-last-checked">Last checked: {new Date(state.lastCheckedAt).toLocaleString()}</p>}
  </section>;
}

import { t } from '../i18n';
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
    <div className="update-settings-heading"><h3 id="updates-title">{t("Updates")}</h3><span>{state ? t("Installed: {0}", state.currentVersion) : t("Loading version…")}</span></div>
    <p className="update-status" role="status">{ready ? t("Version {0} is ready to install.", transfer.version)
      : downloading ? <><span className="inline-spinner" />{transfer?.phase === 'downloading' ? t("Downloading update…") : t("Preparing download…")}</>
      : checking ? <><span className="inline-spinner" />{t("Checking for updates…")}</>
      : state?.available ? t("Version {0} is available.", state.latestVersion)
      : state?.status === 'current' ? t("You’re up to date.")
      : state?.status === 'error' ? t("Unable to check for updates.") : t("Check GitHub for the latest version.")}</p>
    {downloading && <div className="update-download-progress">
      <div className={`update-progress-track${transfer?.phase === 'downloading' ? '' : ' is-preparing'}`} role="progressbar" aria-label={t("Update download progress")}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={transfer?.phase === 'downloading' ? transfer.percent : undefined}>
        <span style={{ width: transfer?.phase === 'downloading' ? `${transfer.percent}%` : '30%' }} />
      </div>
      {transfer?.phase === 'downloading' && <span>{Math.floor(transfer.percent)}%{transfer.total > 0 ? ` · ${megabytes(transfer.transferred)} / ${megabytes(transfer.total)}` : ''}</span>}
    </div>}
    {(installError || transfer?.error || error || state?.error) && <p className="update-error" role="alert">{installError || transfer?.error || error || state?.error}</p>}
    <div className="update-settings-actions">
      <button className="button outline" onClick={() => void check()} disabled={checking || downloading || ready || busy}><RefreshCw size={15} />{t("Check for updates")}</button>
      {ready ? <button className="button primary" onClick={onInstall} disabled={busy}><RefreshCw size={15} />{t("Restart and install")}</button>
        : state?.available && <button className="button primary" onClick={() => void download()} disabled={downloading || checking || busy}>
          <Download size={15} />{downloading ? t("Downloading…") : transfer?.phase === 'error' ? t("Retry download") : t("Download update")}</button>}
    </div>
    {ready && <p className="update-message">{t("Your unsaved PDF changes will be saved before restarting. Canceling or failing a save keeps AsterPDF open.")}</p>}
    <p className="update-check-note">{t("Checks automatically every 24 hours while AsterPDF is running, or when you next open it. PDF files stay on your computer.")}</p>
    {state?.lastCheckedAt && <p className="update-last-checked">{t("Last checked:")} {new Date(state.lastCheckedAt).toLocaleString()}</p>}
  </section>;
}

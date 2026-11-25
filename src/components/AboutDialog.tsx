import { t } from '../i18n';
import { useLayoutEffect, useRef } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { useUpdates } from '../updates';

export default function AboutDialog({ updates, busy, onClose }: {
  updates: ReturnType<typeof useUpdates>; busy: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  const { state, checking, downloading, error, check } = updates;
  const ready = state?.transfer.phase === 'ready';
  const status = checking ? 'Checking for updates…'
    : error || state?.error || (ready ? t('Version {0} is ready to install.', state.transfer.version)
      : state?.available ? t('Version {0} is available.', state.latestVersion)
      : state?.status === 'current' ? 'You’re up to date.'
      : state?.status === 'error' ? 'Unable to check for updates. Please try again.' : '');

  return <dialog ref={dialog} className="about-dialog" aria-labelledby="about-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="about-content">
      <button className="icon-button about-close" aria-label={t("Close About")} onClick={onClose} autoFocus><X size={18} /></button>
      <h2 id="about-title">{t("About AsterPDF")}</h2>
      <p className="about-version">{state ? t("Version {0}", state.currentVersion) : t("Loading version…")}</p>
      <dl className="about-details">
        <div><dt>{t("Author")}</dt><dd>Yousif Aldhafeeri</dd></div>
        <div><dt>{t("License")}</dt><dd>MIT</dd></div>
      </dl>
      <div className="about-updates">
        {status && <p role="status">{t(status)}</p>}
        <button className="button outline" onClick={() => void check()} disabled={checking || downloading || ready || busy}>
          {checking ? <span className="inline-spinner" /> : <RefreshCw size={14} />}
          {checking ? t("Checking…") : t("Check for updates")}
        </button>
      </div>
    </div>
  </dialog>;
}

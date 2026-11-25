import { t } from '../i18n';
import { useLayoutEffect, useRef } from 'react';
import UpdateSettings from './UpdateSettings';
import { X } from 'lucide-react';
import type { useUpdates } from '../updates';

export default function AboutDialog({ updates, busy, onClose, onInstall, installError, installStage }: {
  updates: ReturnType<typeof useUpdates>; busy: boolean; onClose: () => void; onInstall: () => void; installError: string; installStage?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  const { state } = updates;
  return <dialog ref={dialog} className="about-dialog" aria-labelledby="about-title"
    onCancel={(event) => { event.preventDefault(); if (!installStage) onClose(); }}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => { if (!installStage && event.target === event.currentTarget) onClose(); }}>
    <div className="about-content">
      <button className="icon-button about-close" aria-label={t("Close About")} onClick={onClose} disabled={!!installStage} autoFocus><X size={18} /></button>
      <h2 id="about-title">{t("About AsterPDF")}</h2>
      <p className="about-version">{state ? t("Version {0}", state.currentVersion) : t("Loading version…")}</p>
      <dl className="about-details">
        <div><dt>{t("Author")}</dt><dd>Yousif Aldhafeeri</dd></div>
        <div><dt>{t("License")}</dt><dd>MIT</dd></div>
      </dl>
      <div className="about-updates">
        {installStage ? <div role="status"><p>{installStage}</p><progress aria-label={installStage} /></div>
          : <UpdateSettings compact updates={updates} busy={busy} onInstall={onInstall} installError={installError} />}
      </div>
    </div>
  </dialog>;
}

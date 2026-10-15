import { useEffect, useState } from 'react';
import type { UpdateStatus } from './types';

export function useUpdates() {
  const [state, setState] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, received = false;
    const unsubscribe = window.aster.onUpdateStatus((next) => { received = true; if (active) setState(next); });
    window.aster.getUpdateStatus().then((next) => { if (active && !received) setState(next); })
      .catch(() => { if (active) setError('Could not load update status. Try checking again.'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const check = async () => {
    setChecking(true); setError('');
    try { setState(await window.aster.checkForUpdates()); }
    catch { setError('Could not check for updates. Try again.'); }
    finally { setChecking(false); }
  };
  const download = async () => {
    setStarting(true); setError('');
    try {
      setState(await window.aster.downloadUpdate());
    } catch { setError('Could not download the update. Try checking again.'); }
    finally { setStarting(false); }
  };
  const downloading = starting || state?.transfer.phase === 'preparing' || state?.transfer.phase === 'downloading';
  return { state, checking: checking || state?.status === 'checking', downloading, error, check, download };
}

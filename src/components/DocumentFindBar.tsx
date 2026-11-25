import { CaseSensitive, Check, ChevronDown, ChevronUp, LoaderCircle, Search, WholeWord, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { languageState, t } from '../i18n';
import type { useDocumentSearch } from './useDocumentSearch';

export default function DocumentFindBar({ search, compact, focusRequest, close }: {
  search: ReturnType<typeof useDocumentSearch>; compact: boolean; focusRequest: number; close: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus({ preventScroll: true }); input.current?.select(); }, [focusRequest]);
  const { query, total, index, scanning, incomplete } = search;
  const matchCount = total ? t('{0} of {1}', index + 1, total) : '';
  let status = matchCount;
  if (!total && scanning) status = t('Searching…');
  else if (!total && query.trim()) status = t(search.textFound || incomplete ? 'No matches' : 'No searchable text');
  if (incomplete) status += t(' · Some pages unavailable');
  return <div className={'document-find' + (compact ? ' compact' : '')} role="search" dir={languageState.language === 'ar' ? 'rtl' : 'ltr'} aria-label={t('Find in document')}>
    <label className="document-find-input">
      {matchCount && <span className="document-find-count" aria-hidden="true">{matchCount}</span>}
      <span className="document-find-icon" aria-hidden="true" title={status || undefined}>
        {scanning ? <LoaderCircle size={16} className="find-spinner" />
          : search.showOutcome ? (total ? <Check size={16} className="find-outcome found" /> : <X size={16} className="find-outcome empty" />)
          : <Search size={16} />}
      </span>
      <input ref={input} dir="auto" aria-label={t('Find in document')} placeholder={t('Find in document')} value={query}
        onChange={e => search.setQuery(e.target.value)} onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); search.step(e.shiftKey ? -1 : 1); }
        }} />
    </label>
    {!compact && <div className="document-find-options">
      <button type="button" title={t('Match case')} aria-label={t('Match case')} aria-pressed={search.matchCase} onClick={() => search.setMatchCase(!search.matchCase)}><CaseSensitive size={18}/></button>
      <button type="button" title={t('Whole words')} aria-label={t('Whole words')} aria-pressed={search.wholeWords} onClick={() => search.setWholeWords(!search.wholeWords)}><WholeWord size={17}/></button>
    </div>}
    <span className="document-find-announcement" role="status">{status}</span>
    <button type="button" title={t('Previous match')} aria-label={t('Previous match')} disabled={!total} onClick={() => search.step(-1)}><ChevronUp size={17}/></button>
    <button type="button" title={t('Next match')} aria-label={t('Next match')} disabled={!total} onClick={() => search.step(1)}><ChevronDown size={17}/></button>
    <button type="button" title={t('Close search')} aria-label={t('Close search')} onClick={close}><X size={16}/></button>
  </div>;
}

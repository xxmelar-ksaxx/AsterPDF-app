import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PlannedPage } from '../pdf/page-plan';
import type { OverlayObject } from '../pdf/overlays';
import { findInRuns, searchQuery, type SearchHit, type SearchRun } from '../pdf/search';

const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<SearchRun[]>>>();
function readPage(pdf: PDFDocumentProxy, page: number) {
  let pages = cache.get(pdf);
  if (!pages) cache.set(pdf, pages = new Map());
  let pending = pages.get(page);
  if (!pending) {
    pending = pdf.getPage(page).then(p => p.getTextContent()).then(content =>
      content.items.flatMap(item => 'str' in item ? [{ str: item.str, hasEOL: item.hasEOL }] : []));
    pages.set(page, pending);
    pending.catch(() => pages.delete(page));
  }
  return pending;
}

type Group = { page: number; hits: SearchHit[]; first: number };
export function useDocumentSearch(pdf: PDFDocumentProxy | null, pages: PlannedPage[], objects: OverlayObject[], open: boolean, readingPage: number) {
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWords, setWholeWords] = useState(false);
  const [index, setIndex] = useState(0);
  const [groups, setGroups] = useState<Group[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showOutcome, setShowOutcome] = useState(false);
  const [textFound, setTextFound] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const readingPageRef = useRef(readingPage);
  readingPageRef.current = readingPage;
  const needle = searchQuery(query, matchCase);
  useLayoutEffect(() => {
    let cancelled = false;
    let outcomeTimer: number | undefined;
    const enabled = Boolean(open && needle && pdf);
    setGroups([]); setIndex(0); setScanning(enabled); setIncomplete(false); setTextFound(false);
    setShowOutcome(false);
    if (!enabled || !pdf) return;
    const startPage = readingPageRef.current;
    const timer = window.setTimeout(async () => {
      const found: Group[] = [];
      let selected = false;
      let count = 0, lastPaint = 0, hasText = false;
      const overlays = new Map<string, OverlayObject[]>();
      for (const obj of objects) if (obj.kind === 'text' && obj.text && !obj.hidden) {
        const group = overlays.get(obj.pageId) ?? [];
        group.push(obj); overlays.set(obj.pageId, group);
      }
      for (const [i, page] of pages.entries()) {
        let runs: SearchRun[] = [];
        try { runs = await readPage(pdf, page.sourceIndex + 1); }
        catch { if (!cancelled) setIncomplete(true); }
        if (cancelled) return;
        const options = { matchCase, wholeWords };
        hasText ||= overlays.has(page.id) || runs.some(run => run.str.trim());
        const hits = findInRuns(runs, needle, options);
        for (const obj of overlays.get(page.id) ?? []) {
          for (const hit of findInRuns([{ str: obj.text! }], needle, options))
            hits.push({ ...hit, overlayId: obj.id });
        }
        if (hits.length) {
          found.push({ page: i + 1, hits, first: count });
          if (!selected && i + 1 >= startPage) { setIndex(count); selected = true; }
          count += hits.length;
        }
        if (performance.now() - lastPaint > 40) {
          if (selected) setGroups([...found]);
          lastPaint = performance.now();
          await new Promise(resolve => setTimeout(resolve, 0));
          if (cancelled) return;
        }
      }
      setGroups(found); setTextFound(hasText); setScanning(false);
      setShowOutcome(true);
      outcomeTimer = window.setTimeout(() => setShowOutcome(false), 1000);
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); window.clearTimeout(outcomeTimer); };
  }, [pdf, open, pages, objects, needle, matchCase, wholeWords]);
  const byPage = useMemo(() => new Map(groups.map(group => [group.page, group])), [groups]);
  const last = groups.at(-1);
  const total = last ? last.first + last.hits.length : 0;
  const active = groups.find(group => index >= group.first && index < group.first + group.hits.length);
  const hit = active?.hits[index - active.first];
  function step(direction: number) {
    if (total) setIndex(i => (i + direction + total) % total);
  }
  return { query, setQuery, matchCase, setMatchCase, wholeWords, setWholeWords, scanning, showOutcome, incomplete, textFound,
    index, total, step, byPage, activePage: active?.page, hit };
}

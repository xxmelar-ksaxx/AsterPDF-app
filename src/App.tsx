import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ChevronLeft, ChevronRight, CircleHelp, FilePlus2, FileText,
  FolderOpen, MessageSquare, Minus, Plus, Save, Settings2, X
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { addTextNotes, readPageComments, type NewNote, type PdfComment } from './pdf/comments';
import type { OpenedPdf, RecentPdf } from './types';
import PdfPage, { pageScale, type PageSize, type PendingPoint, type Zoom } from './components/PdfPage';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

type SidebarTab = 'comments' | 'pages';
const DEFAULT_PAGE_SIZE: PageSize = { width: 612, height: 792 };
const EMPTY_COMMENTS: PdfComment[] = [];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayDate(value?: string): string {
  if (!value) return '';
  if (value.startsWith('D:') && value.length >= 10) {
    const year = Number(value.slice(2, 6));
    const month = Number(value.slice(6, 8)) - 1;
    const day = Number(value.slice(8, 10));
    const parsed = new Date(year, month, day);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString();
}

function commentLabel(comment: PdfComment): string {
  return comment.text || '(Empty note)';
}

export default function App() {
  const [source, setSource] = useState<OpenedPdf | null>(null);
  const [recentPdfs, setRecentPdfs] = useState<RecentPdf[]>([]);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('comments');
  const [comments, setComments] = useState<PdfComment[]>([]);
  const [drafts, setDrafts] = useState<NewNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<PendingPoint | null>(null);
  const [noteText, setNoteText] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorInput, setAuthorInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoSaveRevision, setAutoSaveRevision] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [viewerWidth, setViewerWidth] = useState(900);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const restoreScrollRef = useRef<number | null>(null);
  const zoomAnchorRef = useRef<{ page: number; localOffset: number; scale: number } | null>(null);
  const savingRef = useRef(false);
  const lastAutoAttemptRef = useRef(0);

  const measurePage = useCallback((page: number, size: PageSize) => {
    setPageSizes((previous) => {
      const existing = previous[page];
      if (existing && Math.abs(existing.width - size.width) < 0.1 && Math.abs(existing.height - size.height) < 0.1) return previous;
      return { ...previous, [page]: size };
    });
  }, []);

  const registerPage = useCallback((page: number, element: HTMLDivElement | null) => {
    if (element) pageRefs.current.set(page, element);
    else pageRefs.current.delete(page);
  }, []);

  const reportPageError = useCallback((message: string) => setError(message), []);

  const refreshRecent = useCallback(async () => {
    try { setRecentPdfs(await window.aster.getRecentPdfs()); }
    catch (cause) { setError(`Could not load recent PDFs: ${messageOf(cause)}`); }
  }, []);

  useEffect(() => { void refreshRecent(); }, [refreshRecent]);

  useEffect(() => {
    window.aster.getSettings().then((settings) => {
      setAuthorName(settings.authorName);
      setAuthorInput(settings.authorName);
    }).catch((cause) => setError(messageOf(cause)));
  }, []);

  useEffect(() => {
    window.aster.setDirty(drafts.length > 0);
  }, [drafts]);

  useEffect(() => {
    const element = viewerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewerWidth(element.clientWidth));
    observer.observe(element);
    setViewerWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [source]);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    let previewRenderTask: { cancel(): void } | undefined;
    setDocument(null);
    setComments([]);
    setPageSizes({});
    setScanning(true);
    const restoreScroll = restoreScrollRef.current;
    if (restoreScroll === null) viewerRef.current?.scrollTo(0, 0);
    restoreScrollRef.current = null;
    (async () => {
      try {
        task = pdfjs.getDocument({ data: source.bytes.slice() });
        const pdf = await task.promise;
        if (cancelled) return;
        const first = await pdf.getPage(1);
        const firstViewport = first.getViewport({ scale: 1 });
        measurePage(1, { width: firstViewport.width, height: firstViewport.height });
        setDocument(pdf);
        setPageNumber(1);
        void (async () => {
          const scale = Math.min(180 / firstViewport.width, 230 / firstViewport.height);
          const viewport = first.getViewport({ scale });
          const canvas = window.document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const context = canvas.getContext('2d');
          if (!context) return;
          const rendering = first.render({ canvas, canvasContext: context, viewport });
          previewRenderTask = rendering;
          await rendering.promise;
          if (!cancelled) {
            await window.aster.setRecentPreview(source.path, canvas.toDataURL('image/jpeg', 0.78));
            await refreshRecent();
          }
        })().catch(() => {});
        if (restoreScroll !== null) requestAnimationFrame(() => viewerRef.current?.scrollTo(0, restoreScroll));
        for (let page = 1; page <= pdf.numPages; page += 1) {
          if (cancelled) break;
          try {
            const pdfPage = await pdf.getPage(page);
            const natural = pdfPage.getViewport({ scale: 1 });
            if (!cancelled) measurePage(page, { width: natural.width, height: natural.height });
            const data = await pdfPage.getAnnotations({ intent: 'display' });
            if (!cancelled) setComments((previous) => [...previous, ...readPageComments(data, page)]);
          } catch {
            if (!cancelled) setError(`Could not read comments on page ${page}.`);
          }
        }
      } catch (cause) {
        if (!cancelled) setError(`Could not open PDF: ${messageOf(cause)}`);
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
      previewRenderTask?.cancel();
      task?.destroy();
    };
  }, [source, measurePage, refreshRecent]);

  const allComments = useMemo(() => [
    ...comments,
    ...drafts.map((note): PdfComment => ({
      id: note.id,
      page: note.page,
      author: note.author,
      text: note.text,
      kind: 'Text note',
      date: note.date,
      rect: [note.x, note.y, note.x + 24, note.y + 24],
      draft: true
    }))
  ].sort((a, b) => a.page - b.page), [comments, drafts]);
  const commentsByPage = useMemo(() => {
    const grouped = new Map<number, PdfComment[]>();
    for (const comment of allComments) {
      const current = grouped.get(comment.page) ?? [];
      current.push(comment);
      grouped.set(comment.page, current);
    }
    return grouped;
  }, [allComments]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !document) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const readingLine = viewer.scrollTop + viewer.clientHeight * 0.35;
      for (let page = 1; page <= document.numPages; page += 1) {
        const sheet = pageRefs.current.get(page);
        if (!sheet) continue;
        if (sheet.offsetTop + sheet.offsetHeight > readingLine || page === document.numPages) {
          setPageNumber(page);
          break;
        }
      }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    viewer.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(viewer);
    onScroll();
    return () => {
      viewer.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [document]);

  const scrollToPage = useCallback((target: number) => {
    const viewer = viewerRef.current;
    const sheet = pageRefs.current.get(target);
    if (!viewer || !sheet) return;
    viewer.scrollTo({ top: Math.max(0, sheet.offsetTop - 20), behavior: 'smooth' });
  }, []);

  const jumpToComment = useCallback(async (comment: PdfComment) => {
    setSelectedId(comment.id);
    const viewer = viewerRef.current;
    const sheet = pageRefs.current.get(comment.page);
    if (!viewer || !sheet || !document) return;
    try {
      const page = await document.getPage(comment.page);
      const natural = page.getViewport({ scale: 1 });
      measurePage(comment.page, { width: natural.width, height: natural.height });
      const viewport = page.getViewport({ scale: pageScale(natural, zoom, viewerWidth) });
      const first = viewport.convertToViewportPoint(comment.rect[0], comment.rect[1]);
      const second = viewport.convertToViewportPoint(comment.rect[2], comment.rect[3]);
      const stage = sheet.querySelector<HTMLElement>('.page-stage');
      const top = sheet.offsetTop + (stage?.offsetTop ?? 0) + Math.min(first[1], second[1]) - viewer.clientHeight * 0.42;
      viewer.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } catch (cause) { setError(messageOf(cause)); }
  }, [document, measurePage, zoom, viewerWidth]);

  const openSelected = useCallback(async () => {
    if (savingRef.current) { setError('Please wait for the PDF to finish saving.'); return; }
    try {
      const opened = await window.aster.openDialog();
      if (opened) {
        restoreScrollRef.current = null;
        setDrafts([]);
        setSource(opened);
        setSelectedId(null);
        setPendingPoint(null);
        setPlacing(false);
        setError('');
        void refreshRecent();
      }
    } catch (cause) { setError(messageOf(cause)); }
  }, [refreshRecent]);

  const openPath = useCallback(async (filePath: string) => {
    if (savingRef.current) { setError('Please wait for the PDF to finish saving.'); return; }
    try {
      const opened = await window.aster.openPath(filePath);
      if (opened) {
        restoreScrollRef.current = null;
        setDrafts([]);
        setSource(opened);
        setSelectedId(null);
        setPendingPoint(null);
        setPlacing(false);
        setError('');
        void refreshRecent();
      }
    } catch (cause) { setError(messageOf(cause)); }
  }, [refreshRecent]);

  const save = useCallback(async (saveAs = false) => {
    if (!source || savingRef.current || (!saveAs && drafts.length === 0)) return;
    const batch = drafts.slice();
    const savedIds = new Set(batch.map((note) => note.id));
    const startedAt = performance.now();
    savingRef.current = true;
    window.aster.setSaving(true);
    setBusy(true);
    try {
      const bytes = batch.length ? await addTextNotes(source.bytes, batch) : source.bytes;
      const saved = await window.aster.save(bytes, saveAs, source.path);
      if (saved) {
        restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
        setDrafts((current) => current.filter((note) => !savedIds.has(note.id)));
        setSource({ ...saved, bytes });
        setError('');
        void refreshRecent();
      }
    } catch (cause) {
      setError(`Could not save PDF: ${messageOf(cause)}`);
    } finally {
      const remaining = 350 - (performance.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      savingRef.current = false;
      window.aster.setSaving(false);
      setBusy(false);
    }
  }, [source, drafts, refreshRecent]);

  useEffect(() => {
    if (!source || busy || drafts.length === 0 || autoSaveRevision <= lastAutoAttemptRef.current) return;
    lastAutoAttemptRef.current = autoSaveRevision;
    void save();
  }, [autoSaveRevision, busy, drafts, save, source]);

  useEffect(() => {
    const subscriptions = [
      window.aster.onMenu('menu:open', () => void openSelected()),
      window.aster.onMenu('menu:save', () => void save()),
      window.aster.onMenu('menu:save-as', () => void save(true)),
      window.aster.onMenu('menu:settings', () => setSettingsOpen(true))
    ];
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [openSelected, save]);

  const saveSettings = async () => {
    try {
      const settings = await window.aster.setAuthorName(authorInput);
      setAuthorName(settings.authorName);
      setAuthorInput(settings.authorName);
      setSettingsOpen(false);
      setError('');
    } catch (cause) { setError(messageOf(cause)); }
  };

  const startComment = () => {
    if (!authorName) { setSettingsOpen(true); return; }
    setSidebarTab('comments');
    setPlacing((value) => !value);
    setPendingPoint(null);
    setNoteText('');
  };

  const choosePoint = (page: number, x: number, y: number) => {
    setPendingPoint({ page, x, y });
    setPlacing(false);
  };

  const addComment = () => {
    if (!pendingPoint || !noteText.trim() || !authorName) return;
    const id = crypto.randomUUID();
    window.aster.setDirty(true);
    setDrafts((current) => [...current, {
      id, page: pendingPoint.page, x: pendingPoint.x, y: pendingPoint.y,
      author: authorName, text: noteText.trim(), date: new Date().toISOString()
    }]);
    setAutoSaveRevision((revision) => revision + 1);
    setSelectedId(id);
    setPendingPoint(null);
    setNoteText('');
  };

  const removeDraft = (id: string) => {
    if (drafts.length === 1) window.aster.setDirty(false);
    setDrafts((current) => current.filter((note) => note.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const zoomValue = zoom === 'fit' ? 'Fit width' : `${Math.round(zoom * 100)}%`;
  const changeZoom = (next: Zoom) => {
    if (next === zoom) return;
    const viewer = viewerRef.current;
    const sheet = pageRefs.current.get(pageNumber);
    if (viewer && sheet) {
      zoomAnchorRef.current = {
        page: pageNumber,
        localOffset: viewer.scrollTop - sheet.offsetTop,
        scale: pageScale(pageSizes[pageNumber] ?? pageSizes[1] ?? DEFAULT_PAGE_SIZE, zoom, viewerWidth)
      };
    }
    setZoom(next);
  };

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;
    const viewer = viewerRef.current;
    const sheet = pageRefs.current.get(anchor.page);
    if (!viewer || !sheet) return;
    const newScale = pageScale(pageSizes[anchor.page] ?? pageSizes[1] ?? DEFAULT_PAGE_SIZE, zoom, viewerWidth);
    viewer.scrollTop = Math.max(0, sheet.offsetTop + anchor.localOffset * newScale / anchor.scale);
  }, [zoom, viewerWidth, pageSizes]);

  const adjustZoom = (direction: number) => {
    const current = zoom === 'fit'
      ? pageScale(pageSizes[pageNumber] ?? pageSizes[1] ?? DEFAULT_PAGE_SIZE, 'fit', viewerWidth)
      : zoom;
    changeZoom(Math.max(0.4, Math.min(2.5, Math.round((current + direction * 0.2) * 10) / 10)));
  };

  return <div className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) => item.name.toLowerCase().endsWith('.pdf'));
    if (file) void openPath(window.aster.pathForFile(file));
    else setError('Drop a PDF file to open it.');
  }}>
    <header className="topbar">
      <div className="brand"><img src="./icon.png" alt="" /><span>Aster<span className="brand-pdf">PDF</span></span></div>
      <div className="topbar-divider" />
      <div className="document-title" title={source?.path}>{source ? <><FileText size={17} /><strong>{source.name}</strong>{busy ? <span className="saving-spinner" role="status" aria-label="Saving PDF" title="Saving PDF" /> : drafts.length > 0 && <span className="unsaved-dot" title="Unsaved comments" />}</> : <span>No document open</span>}</div>
      <div className="topbar-actions">
        <button className="button subtle" onClick={() => setSettingsOpen(true)} title="Comment author settings"><Settings2 size={18} /><span>Settings</span></button>
        <button className="button subtle" onClick={() => void openSelected()} disabled={busy}><FolderOpen size={18} /><span>Open PDF</span></button>
        <button className="button primary" onClick={() => void save()} disabled={!source || drafts.length === 0 || busy}><Save size={17} /><span>{busy ? 'Saving…' : 'Save'}</span></button>
      </div>
    </header>

    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}

    {!source ? <main className={`welcome ${recentPdfs.length ? 'has-recents' : ''}`}>
      <div className="welcome-mark"><img src="./icon.png" alt="" /></div>
      <span className="eyebrow">YOUR OFFLINE PDF WORKSPACE</span>
      <h1>Every detail, in view.</h1>
      <p>Open a PDF, read every page, and keep the conversation right where it belongs — in the document.</p>
      <button className="button primary welcome-open" onClick={() => void openSelected()}><FolderOpen size={20} /> Open a PDF <ChevronRight size={18} /></button>
      <div className="drop-hint">or drop a PDF anywhere in this window</div>
      {recentPdfs.length > 0 ? <section className="recent-files" aria-labelledby="recent-title">
        <div className="recent-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2 id="recent-title">Recently opened</h2></div><span>{recentPdfs.length} {recentPdfs.length === 1 ? 'PDF' : 'PDFs'}</span></div>
        <div className="recent-list">{recentPdfs.map((recent) => <button key={recent.path} className="recent-file" onClick={() => void openPath(recent.path)} aria-label={`Open ${recent.name}`} title={recent.path}>
          <span className="recent-preview">{recent.preview ? <img src={recent.preview} alt="" /> : <FileText size={30} />}</span>
          <span className="recent-details"><strong>{recent.name}</strong><span>{recent.path}</span><time dateTime={new Date(recent.openedAt).toISOString()}>Opened {new Date(recent.openedAt).toLocaleDateString()}</time></span>
          <ChevronRight size={19} className="recent-chevron" />
        </button>)}</div>
      </section> : <div className="welcome-points"><span><FileText size={18} /> Clear page previews</span><span><MessageSquare size={18} /> PDF comments</span><span><ArrowDownToLine size={18} /> Local files only</span></div>}
    </main> : <main className="workspace">
      <section className="viewer-column">
        <div className="viewer-toolbar">
          <div className="toolbar-group page-control"><button className="icon-button" onClick={() => scrollToPage(Math.max(1, pageNumber - 1))} disabled={pageNumber <= 1} aria-label="Previous page"><ChevronLeft size={18} /></button><span><strong>{pageNumber}</strong><i>/</i>{document?.numPages ?? '…'}</span><button className="icon-button" onClick={() => scrollToPage(Math.min(document?.numPages ?? 1, pageNumber + 1))} disabled={pageNumber >= (document?.numPages ?? 1)} aria-label="Next page"><ChevronRight size={18} /></button></div>
          <div className="toolbar-group zoom-control"><button className="icon-button" onClick={() => adjustZoom(-1)} aria-label="Zoom out"><Minus size={17} /></button><button className="zoom-label" onClick={() => changeZoom('fit')}>{zoomValue}</button><button className="icon-button" onClick={() => adjustZoom(1)} aria-label="Zoom in"><Plus size={17} /></button></div>
          <div className="toolbar-spacer" />
          <button className={`button ${placing ? 'placing-button' : 'outline'}`} onClick={startComment} disabled={!document}><MessageSquare size={17} />{placing ? 'Click on page…' : 'Add comment'}</button>
        </div>
        <div className="viewer-scroll" ref={viewerRef}>
          <div className="page-wrap">
            {!document && <div className="loading-page">Opening PDF…</div>}
            {document && Array.from({ length: document.numPages }, (_, index) => {
              const page = index + 1;
              return <PdfPage key={page} document={document} pageNumber={page}
                size={pageSizes[page] ?? pageSizes[1] ?? DEFAULT_PAGE_SIZE}
                zoom={zoom} viewerWidth={viewerWidth} viewerRef={viewerRef}
                comments={commentsByPage.get(page) ?? EMPTY_COMMENTS} selectedId={selectedId}
                placing={placing} pendingPoint={pendingPoint} registerPage={registerPage}
                onMeasure={measurePage} onPlace={choosePoint}
                onSelectComment={(id) => { setSelectedId(id); setSidebarTab('comments'); }}
                onError={reportPageError} />;
            })}
          </div>
        </div>
        <div className="viewer-footer"><span>{source.path}</span><span>{document?.numPages ?? '…'} pages · Offline</span></div>
      </section>

      <aside className="sidebar">
        <div className="sidebar-tabs"><button className={sidebarTab === 'comments' ? 'active' : ''} onClick={() => setSidebarTab('comments')}><MessageSquare size={17} /> Comments <span>{allComments.length}</span></button><button className={sidebarTab === 'pages' ? 'active' : ''} onClick={() => setSidebarTab('pages')}><FileText size={17} /> Pages</button></div>
        {sidebarTab === 'comments' ? <>
          <div className="sidebar-heading"><div><h2>Comments</h2><p>{scanning ? 'Reading comments…' : allComments.length ? `${allComments.length} in this document` : 'No comments yet'}</p></div><button className="icon-button" title="Save a copy" aria-label="Save a copy" disabled={busy} onClick={() => void save(true)}><FilePlus2 size={19} /></button></div>
          <div className="comment-list">
            {allComments.length === 0 && !pendingPoint ? <div className="empty-comments"><div><MessageSquare size={25} /></div><h3>Start a conversation</h3><p>Comments in this PDF will appear here. Click “Add comment” and choose a spot on the page.</p><button className="text-button" onClick={startComment}>Add the first comment <ChevronRight size={15} /></button></div> : null}
            {allComments.map((comment) => <button key={comment.id} className={`comment-card ${selectedId === comment.id ? 'selected' : ''}`} onClick={() => void jumpToComment(comment)}>
              <div className="comment-meta"><span className="avatar">{comment.author.charAt(0).toUpperCase()}</span><span className="comment-author">{comment.author}</span><span className="comment-page">p. {comment.page}</span></div>
              <p>{commentLabel(comment)}</p>
              <div className="comment-bottom"><span>{comment.kind}{comment.draft ? busy ? ' · Saving…' : ' · Unsaved' : ''}</span><span>{displayDate(comment.date)}</span></div>
              {comment.draft && !busy && <span className="remove-draft" onClick={(event) => { event.stopPropagation(); removeDraft(comment.id); }}>Remove</span>}
            </button>)}
          </div>
          {pendingPoint && <div className="compose"><div className="compose-title"><span className="avatar">{authorName.charAt(0).toUpperCase()}</span><strong>New comment</strong><button onClick={() => setPendingPoint(null)} aria-label="Cancel comment"><X size={17} /></button></div><textarea autoFocus placeholder="Write your comment…" value={noteText} onChange={(event) => setNoteText(event.target.value)} maxLength={10000} /><div className="compose-footer"><span>Page {pendingPoint.page} · {authorName}</span><button className="button primary" onClick={addComment} disabled={!noteText.trim()}>Add comment</button></div></div>}
          <div className="sidebar-bottom"><CircleHelp size={16} /><span>Comments are saved inside the PDF.</span></div>
        </> : <div className="pages-panel"><div className="sidebar-heading"><div><h2>Pages</h2><p>{document?.numPages ?? '…'} pages in this document</p></div></div><div className="page-list">{Array.from({ length: document?.numPages ?? 0 }, (_, index) => <button key={index} className={pageNumber === index + 1 ? 'active' : ''} onClick={() => scrollToPage(index + 1)}><span className="page-symbol"><FileText size={21} /></span><span>Page {index + 1}</span><small>{commentsByPage.get(index + 1)?.length || ''}</small></button>)}</div></div>}
      </aside>
    </main>}

    {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-head"><div className="modal-icon"><Settings2 size={21} /></div><button onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={19} /></button></div><h2 id="settings-title">Comment author</h2><p>This name appears on comments you add to PDF files. It is saved only on this computer.</p><label htmlFor="author-name">Your name</label><input id="author-name" autoFocus value={authorInput} onChange={(event) => setAuthorInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveSettings(); }} placeholder="Enter your name" maxLength={80} /><div className="modal-actions"><button className="button subtle" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="button primary" onClick={() => void saveSettings()} disabled={!authorInput.trim()}>Save settings</button></div></div></div>}
  </div>;
}

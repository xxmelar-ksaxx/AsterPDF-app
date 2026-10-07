import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ChevronLeft, ChevronRight, CircleHelp, FilePlus2, FileText,
  FolderOpen, MessageSquare, Minus, Plus, Save, Settings2, X,
  ArrowUp, ArrowDown, Copy, Trash2, RotateCcw, RotateCw, PenLine, Files, Shrink, Undo2, Redo2
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { addTextNotes, readPageComments, type NewNote, type PdfComment } from './pdf/comments';
import type { OpenedPdf, RecentPdf } from './types';
import type { OpenedFile } from './types';
import PdfPage, { pageScale, type PageSize, type PendingPoint, type Zoom } from './components/PdfPage';
import PageThumbnail from './components/PageThumbnail';
import { convertToPdf } from './import/convert';
import { appendPdfs, composePagePlan, compressPdf, embedSignatures, type CompressionLevel, type PageEdit, type SignatureDraw } from './pdf/edit';
import { changePagePlan, initialPagePlan, remapPageSelection, type PlannedPage } from './pdf/page-plan';
import { cropSignature, importSignature, loadSignatures, storeSignatures, type PlacedSignature, type SavedSignature, type SignatureStroke } from './signatures/library';
import { signatureDrawFromViewport } from './signatures/placement';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

type SidebarTab = 'comments' | 'pages';
const DEFAULT_PAGE_SIZE: PageSize = { width: 612, height: 792 };
const EMPTY_COMMENTS: PdfComment[] = [];
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
type EditorSnapshot = { bytes: Uint8Array; plan: PlannedPage[] | null; pageCount: number };

function remember(history: EditorSnapshot[], snapshot: EditorSnapshot): EditorSnapshot[] {
  const next = [...history, snapshot].slice(-20);
  const usage = () => [...new Set(next.map((item) => item.bytes))].reduce((total, bytes) => total + bytes.byteLength, 0);
  while (next.length > 1 && usage() > MAX_HISTORY_BYTES) next.shift();
  return next;
}

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
  const [editingDirty, setEditingDirty] = useState(false);
  const [pagePlan, setPagePlan] = useState<PlannedPage[] | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [historyPast, setHistoryPast] = useState<EditorSnapshot[]>([]);
  const [historyFuture, setHistoryFuture] = useState<EditorSnapshot[]>([]);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [signatureMenuOpen, setSignatureMenuOpen] = useState(false);
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>([]);
  const [newSignature, setNewSignature] = useState<Pick<SavedSignature, 'dataUrl' | 'aspect' | 'vector'> | null>(null);
  const [newSignatureName, setNewSignatureName] = useState('');
  const [signatureInk, setSignatureInk] = useState('#172333');
  const [placingSignatureId, setPlacingSignatureId] = useState<string | null>(null);
  const [placedSignatures, setPlacedSignatures] = useState<PlacedSignature[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const [pendingSignatureRemoval, setPendingSignatureRemoval] = useState<{ kind: 'placed' | 'saved'; id: string; name?: string } | null>(null);
  const [compressionOpen, setCompressionOpen] = useState(false);
  const [compressionProgress, setCompressionProgress] = useState('');
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
  const signatureDrawingRef = useRef(false);
  const signatureStrokesRef = useRef<SignatureStroke[]>([]);
  const signatureImportRef = useRef<HTMLInputElement>(null);
  const savedBytesRef = useRef<Uint8Array | null>(null);
  const dragPageRef = useRef<number | null>(null);
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
  useEffect(() => { setSavedSignatures(loadSignatures()); }, []);

  useEffect(() => {
    window.aster.getSettings().then((settings) => {
      setAuthorName(settings.authorName);
      setAuthorInput(settings.authorName);
    }).catch((cause) => setError(messageOf(cause)));
  }, []);

  useEffect(() => {
    window.aster.setDirty(drafts.length > 0 || editingDirty || placedSignatures.length > 0 || Boolean(source?.needsSave));
  }, [drafts, editingDirty, placedSignatures.length, source?.needsSave]);

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
            if (!source.needsSave) await window.aster.setRecentPreview(source.path, canvas.toDataURL('image/jpeg', 0.78));
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

  const effectivePages = useMemo(() => document ? (pagePlan ?? initialPagePlan(document.numPages)) : [], [document, pagePlan]);
  const visibleComments = useMemo(() => pagePlan
    ? pagePlan.flatMap((page, index) => comments.filter((comment) => comment.page === page.sourceIndex + 1)
      .map((comment) => ({ ...comment, id: `${page.id}:${comment.id}`, page: index + 1 })))
    : comments, [comments, pagePlan]);

  const allComments = useMemo(() => [
    ...visibleComments,
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
  ].sort((a, b) => a.page - b.page), [visibleComments, drafts]);
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
      for (let page = 1; page <= effectivePages.length; page += 1) {
        const sheet = pageRefs.current.get(page);
        if (!sheet) continue;
        if (sheet.offsetTop + sheet.offsetHeight > readingLine || page === effectivePages.length) {
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
  }, [document, effectivePages.length]);

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
      const planned = effectivePages[comment.page - 1];
      if (!planned) return;
      const page = await document.getPage(planned.sourceIndex + 1);
      const natural = page.getViewport({ scale: 1 });
      measurePage(planned.sourceIndex + 1, { width: natural.width, height: natural.height });
      const size = planned.turns % 2 ? { width: natural.height, height: natural.width } : natural;
      const viewport = page.getViewport({ scale: pageScale(size, zoom, viewerWidth), rotation: natural.rotation + planned.turns * 90 });
      const first = viewport.convertToViewportPoint(comment.rect[0], comment.rect[1]);
      const second = viewport.convertToViewportPoint(comment.rect[2], comment.rect[3]);
      const stage = sheet.querySelector<HTMLElement>('.page-stage');
      const top = sheet.offsetTop + (stage?.offsetTop ?? 0) + Math.min(first[1], second[1]) - viewer.clientHeight * 0.42;
      viewer.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } catch (cause) { setError(messageOf(cause)); }
  }, [document, effectivePages, measurePage, zoom, viewerWidth]);

  const installOpened = useCallback(async (opened: OpenedFile) => {
    setBusy(true);
    try {
      const bytes = await convertToPdf(opened);
      restoreScrollRef.current = null;
      setDrafts([]);
      setEditingDirty(false);
      setPagePlan(null);
      savedBytesRef.current = bytes;
      setSelectedPages(new Set());
      setPlacedSignatures([]);
      setSelectedSignatureId(null);
      setPendingSignatureRemoval(null);
      setPlacingSignatureId(null);
      setSignatureMenuOpen(false);
      setHistoryPast([]);
      setHistoryFuture([]);
      setSource({ path: opened.path, name: opened.kind === 'pdf' ? opened.name : opened.name.replace(/\.[^.]+$/, '.pdf'), bytes, needsSave: opened.kind !== 'pdf' });
      setSelectedId(null);
      setPendingPoint(null);
      setPlacing(false);
      setError('');
      void refreshRecent();
    } catch (cause) {
      setSource(null);
      setDrafts([]);
      setEditingDirty(false);
      setPagePlan(null);
      setPlacedSignatures([]);
      setSelectedSignatureId(null);
      setPendingSignatureRemoval(null);
      setPlacingSignatureId(null);
      window.aster.setDirty(false);
      setError(`Could not open file: ${messageOf(cause)}`);
    }
    finally { setBusy(false); }
  }, [refreshRecent]);

  const openSelected = useCallback(async () => {
    if (savingRef.current) { setError('Please wait for the PDF to finish saving.'); return; }
    try {
      const opened = await window.aster.openDialog();
      if (opened) await installOpened(opened);
    } catch (cause) { setError(messageOf(cause)); }
  }, [installOpened]);

  const openPath = useCallback(async (filePath: string) => {
    if (savingRef.current) { setError('Please wait for the PDF to finish saving.'); return; }
    try {
      const opened = await window.aster.openPath(filePath);
      if (opened) await installOpened(opened);
    } catch (cause) { setError(messageOf(cause)); }
  }, [installOpened]);

  const save = useCallback(async (saveAs = false) => {
    if (!source || savingRef.current || (!saveAs && drafts.length === 0 && !editingDirty && !placedSignatures.length && !source.needsSave)) return;
    const batch = drafts.slice();
    const savedIds = new Set(batch.map((note) => note.id));
    savingRef.current = true;
    window.aster.setSaving(true);
    setBusy(true);
    try {
      const arranged = pagePlan ? await composePagePlan(source.bytes, pagePlan) : source.bytes;
      const draws: SignatureDraw[] = [];
      for (const placement of placedSignatures) {
        const pageIndex = effectivePages.findIndex((page) => page.id === placement.pageId);
        if (pageIndex < 0) continue;
        if (!document) throw new Error('Wait for the PDF to finish opening before saving signatures.');
        const planned = effectivePages[pageIndex];
        const page = await document.getPage(planned.sourceIndex + 1);
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 1, rotation: natural.rotation + planned.turns * 90 });
        draws.push(signatureDrawFromViewport(placement, viewport, pageIndex));
      }
      const signed = await embedSignatures(arranged, draws);
      const bytes = batch.length ? await addTextNotes(signed, batch) : signed;
      const saved = await window.aster.save(bytes, saveAs || Boolean(source.needsSave), source.path);
      if (saved) {
        restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
        setDrafts((current) => current.filter((note) => !savedIds.has(note.id)));
        setEditingDirty(false);
        setPagePlan(null);
        setPlacedSignatures([]);
        setSelectedSignatureId(null);
        setPlacingSignatureId(null);
        savedBytesRef.current = bytes;
        setSource({ ...saved, bytes });
        setError('');
        void refreshRecent();
      }
    } catch (cause) {
      setError(`Could not save PDF: ${messageOf(cause)}`);
    } finally {
      savingRef.current = false;
      window.aster.setSaving(false);
      setBusy(false);
    }
  }, [source, document, effectivePages, drafts, editingDirty, pagePlan, placedSignatures, refreshRecent]);

  const applyEdit = useCallback(async (edit: PageEdit) => {
    if (!source || !document || busy || drafts.length || pendingPoint) return;
    try {
      const current = pagePlan ?? initialPagePlan(document.numPages);
      const next = changePagePlan(current, edit);
      if (next.length === current.length && next.every((page, index) => page.id === current[index].id && page.turns === current[index].turns)) return;
      setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: current.length }));
      setHistoryFuture([]);
      window.aster.setDirty(true);
      setEditingDirty(true);
      setSelectedPages(remapPageSelection(current, next, selectedPages));
      setSelectedId(null);
      setPagePlan(next);
      setPageNumber((page) => Math.min(page, next.length));
      setSidebarTab('pages');
      setError('');
    } catch (cause) { setError(`Could not edit pages: ${messageOf(cause)}`); }
  }, [source, document, pagePlan, selectedPages, busy, drafts, pendingPoint]);

  const addFiles = useCallback(async (afterPage?: number) => {
    if (!source || busy || drafts.length) return;
    try {
      const files = await window.aster.addDialog();
      if (!files?.length) return;
      setBusy(true);
      const additions: Uint8Array[] = [];
      for (const file of files) additions.push(await convertToPdf(file));
      const addedCount = afterPage === undefined ? 0 : (await Promise.all(additions.map(async (bytes) => (await PDFDocument.load(bytes)).getPageCount()))).reduce((sum, count) => sum + count, 0);
      const arranged = pagePlan ? await composePagePlan(source.bytes, pagePlan) : source.bytes;
      const bytes = await appendPdfs(arranged, additions, afterPage);
      setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length }));
      setHistoryFuture([]);
      window.aster.setDirty(true);
      setEditingDirty(true);
      setPlacedSignatures((current) => current.flatMap((placement) => {
        const index = effectivePages.findIndex((page) => page.id === placement.pageId);
        return index < 0 ? [] : [{ ...placement, pageId: `source-${index + (afterPage !== undefined && index > afterPage ? addedCount : 0)}` }];
      }));
      setPagePlan(null);
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes });
      setSidebarTab('pages');
      setError('');
    } catch (cause) { setError(`Could not add files: ${messageOf(cause)}`); }
    finally { setBusy(false); }
  }, [source, pagePlan, effectivePages, busy, drafts]);

  const runCompression = useCallback(async (level: CompressionLevel) => {
    if (!source || busy || drafts.length) return;
    setCompressionOpen(false);
    setBusy(true);
    setCompressionProgress('Optimizing…');
    try {
      const arranged = pagePlan ? await composePagePlan(source.bytes, pagePlan) : source.bytes;
      const bytes = await compressPdf(arranged, level, (page, total) => setCompressionProgress(`Compressing page ${page} of ${total}…`));
      if (bytes.byteLength < arranged.byteLength) {
        setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length }));
        setHistoryFuture([]);
        window.aster.setDirty(true);
        setEditingDirty(true);
        setPlacedSignatures((current) => current.flatMap((placement) => {
          const index = effectivePages.findIndex((page) => page.id === placement.pageId);
          return index < 0 ? [] : [{ ...placement, pageId: `source-${index}` }];
        }));
        setPagePlan(null);
        restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
        setSource({ ...source, bytes, needsSave: true });
      } else {
        setError('This preset could not make the PDF smaller. The original remains open.');
        return;
      }
      setError('');
    } catch (cause) { setError(`Could not compress PDF: ${messageOf(cause)}`); }
    finally { setBusy(false); setCompressionProgress(''); }
  }, [source, pagePlan, effectivePages, busy, drafts]);

  const addSignatureAt = useCallback((pageId: string, placement: Omit<PlacedSignature, 'id' | 'pageId' | 'signatureId' | 'dataUrl'>) => {
    const signature = savedSignatures.find((item) => item.id === placingSignatureId);
    if (!signature) return;
    const id = crypto.randomUUID();
    setPlacedSignatures((current) => [...current, { ...placement, id, pageId, signatureId: signature.id,
      dataUrl: signature.dataUrl, vector: signature.vector }]);
    setSelectedSignatureId(id);
    setPlacingSignatureId(null);
    setEditingDirty(true);
    window.aster.setDirty(true);
  }, [savedSignatures, placingSignatureId]);

  const updateSignature = useCallback((id: string, placement: Pick<PlacedSignature, 'x' | 'y' | 'width' | 'height'>) => {
    setPlacedSignatures((current) => current.map((item) => item.id === id ? { ...item, ...placement } : item));
    setEditingDirty(true);
  }, []);

  const deleteSignature = useCallback((id: string) => {
    const remaining = placedSignatures.filter((item) => item.id !== id);
    setPlacedSignatures(remaining);
    setSelectedSignatureId((current) => current === id ? null : current);
    if (!remaining.length && !pagePlan && source?.bytes === savedBytesRef.current && !source.needsSave) setEditingDirty(false);
  }, [placedSignatures, pagePlan, source]);

  const requestSignatureRemoval = useCallback((id: string) => {
    setPendingSignatureRemoval({ kind: 'placed', id });
  }, []);

  const undoEdit = useCallback(() => {
    if (!source || busy || drafts.length || !historyPast.length) return;
    const previous = historyPast[historyPast.length - 1];
    setHistoryPast((history) => history.slice(0, -1));
    setHistoryFuture((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length }));
    const dirty = previous.bytes !== savedBytesRef.current || previous.plan !== null;
    setEditingDirty(dirty);
    window.aster.setDirty(dirty || Boolean(source.needsSave));
    const currentPages = pagePlan ?? initialPagePlan(effectivePages.length);
    const previousPages = previous.plan ?? initialPagePlan(previous.pageCount);
    setSelectedPages(remapPageSelection(currentPages, previousPages, selectedPages));
    setPagePlan(previous.plan);
    if (previous.bytes !== source.bytes) {
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes: previous.bytes });
    }
  }, [source, pagePlan, effectivePages.length, selectedPages, busy, drafts, historyPast]);

  const redoEdit = useCallback(() => {
    if (!source || busy || drafts.length || !historyFuture.length) return;
    const next = historyFuture[historyFuture.length - 1];
    setHistoryFuture((history) => history.slice(0, -1));
    setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length }));
    const dirty = next.bytes !== savedBytesRef.current || next.plan !== null;
    setEditingDirty(dirty);
    window.aster.setDirty(dirty || Boolean(source.needsSave));
    const currentPages = pagePlan ?? initialPagePlan(effectivePages.length);
    const nextPages = next.plan ?? initialPagePlan(next.pageCount);
    setSelectedPages(remapPageSelection(currentPages, nextPages, selectedPages));
    setPagePlan(next.plan);
    if (next.bytes !== source.bytes) {
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes: next.bytes });
    }
  }, [source, pagePlan, effectivePages.length, selectedPages, busy, drafts, historyFuture]);

  const selectedIndices = selectedPages.size ? [...selectedPages].sort((a, b) => a - b) : [pageNumber - 1];
  const applySelection = (action: Extract<PageEdit, { type: 'batch' }>['action']) =>
    void applyEdit({ type: 'batch', pages: selectedIndices, action });

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
    if (editingDirty || placedSignatures.length) { setError('Save your edits before adding a comment so only the comment is auto-saved.'); return; }
    if (!authorName) { setSettingsOpen(true); return; }
    setSidebarTab('comments');
    setPlacing((value) => !value);
    setPendingPoint(null);
    setNoteText('');
  };

  const startSignature = () => { setSignatureMenuOpen((open) => !open); setPlacing(false); };

  const openNewSignature = () => {
    setSignatureMenuOpen(false);
    setNewSignature(null);
    signatureStrokesRef.current = [];
    setNewSignatureName(`Signature ${savedSignatures.length + 1}`);
    setSignatureOpen(true);
  };

  const chooseSignature = (id: string) => {
    setPlacingSignatureId(id);
    setSelectedSignatureId(null);
    setSignatureMenuOpen(false);
    setPlacing(false);
  };

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (pendingSignatureRemoval) return;
      const target = event.target as Element;
      if (!target.closest('.signature-picker')) setSignatureMenuOpen(false);
      if (!target.closest('.editable-signature, .signature-context-menu')) setSelectedSignatureId(null);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (pendingSignatureRemoval) {
        if (event.key === 'Escape') setPendingSignatureRemoval(null);
        return;
      }
      if (event.key === 'Escape') { setPlacingSignatureId(null); setSignatureMenuOpen(false); setSelectedSignatureId(null); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedSignatureId &&
        !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) requestSignatureRemoval(selectedSignatureId);
    };
    window.document.addEventListener('pointerdown', outside);
    window.document.addEventListener('keydown', keyDown);
    return () => { window.document.removeEventListener('pointerdown', outside); window.document.removeEventListener('keydown', keyDown); };
  }, [selectedSignatureId, pendingSignatureRemoval, requestSignatureRemoval]);

  const signaturePointer = (event: React.PointerEvent<HTMLCanvasElement>, begin: boolean) => {
    const canvas = signatureCanvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const bounds = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width));
    const y = Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height));
    context.lineWidth = 7;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = signatureInk;
    if (begin) {
      signatureDrawingRef.current = true;
      signatureStrokesRef.current.push({ color: signatureInk, width: 7, points: [{ x, y }] });
      canvas.setPointerCapture(event.pointerId);
      context.beginPath();
      context.moveTo(x, y);
    } else if (signatureDrawingRef.current) {
      signatureStrokesRef.current.at(-1)?.points.push({ x, y });
      context.lineTo(x, y);
      context.stroke();
    }
  };

  const finishSignature = () => {
    if (!signatureDrawingRef.current) return;
    signatureDrawingRef.current = false;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    setNewSignature(cropSignature(canvas, signatureStrokesRef.current));
  };

  const importSignatureFile = async (file?: File) => {
    if (!file) return;
    try {
      setNewSignature(await importSignature(file));
      signatureStrokesRef.current = [];
      signatureCanvasRef.current?.getContext('2d')?.clearRect(0, 0, 1500, 510);
      setNewSignatureName(file.name.replace(/\.[^.]+$/, '').slice(0, 40) || `Signature ${savedSignatures.length + 1}`);
      setError('');
    } catch (cause) { setError(`Could not import signature: ${messageOf(cause)}`); }
  };

  const useSignature = () => {
    if (!newSignature) return;
    const signature: SavedSignature = { id: crypto.randomUUID(), name: newSignatureName.trim() || `Signature ${savedSignatures.length + 1}`, ...newSignature };
    const next = [...savedSignatures, signature];
    try { storeSignatures(next); } catch { setError('Signature is available now but could not be stored for the next session.'); }
    setSavedSignatures(next);
    setSignatureOpen(false);
    setPlacingSignatureId(signature.id);
    setPlacing(false);
  };

  const removeSavedSignature = (id: string) => {
    const next = savedSignatures.filter((item) => item.id !== id);
    try { storeSignatures(next); } catch (cause) { setError(`Could not update signatures: ${messageOf(cause)}`); return; }
    setSavedSignatures(next);
    if (placingSignatureId === id) setPlacingSignatureId(null);
  };

  const confirmSignatureRemoval = () => {
    if (!pendingSignatureRemoval) return;
    if (pendingSignatureRemoval.kind === 'saved') removeSavedSignature(pendingSignatureRemoval.id);
    else deleteSignature(pendingSignatureRemoval.id);
    setPendingSignatureRemoval(null);
  };

  const choosePoint = (page: number, x: number, y: number) => {
    setPendingPoint({ page, x, y });
    setPlacing(false);
  };

  const addComment = () => {
    if (!pendingPoint || !noteText.trim() || !authorName || editingDirty || placedSignatures.length) return;
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

  const activeSignature = savedSignatures.find((item) => item.id === placingSignatureId) ?? null;
  const zoomValue = zoom === 'fit' ? 'Fit width' : `${Math.round(zoom * 100)}%`;
  const displayPageSize = (number: number): PageSize => {
    const planned = effectivePages[number - 1];
    const natural = pageSizes[(planned?.sourceIndex ?? 0) + 1] ?? pageSizes[1] ?? DEFAULT_PAGE_SIZE;
    return planned && planned.turns % 2 ? { width: natural.height, height: natural.width } : natural;
  };
  const changeZoom = (next: Zoom) => {
    if (next === zoom) return;
    const viewer = viewerRef.current;
    const sheet = pageRefs.current.get(pageNumber);
    if (viewer && sheet) {
      zoomAnchorRef.current = {
        page: pageNumber,
        localOffset: viewer.scrollTop - sheet.offsetTop,
        scale: pageScale(displayPageSize(pageNumber), zoom, viewerWidth)
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
    const newScale = pageScale(displayPageSize(anchor.page), zoom, viewerWidth);
    viewer.scrollTop = Math.max(0, sheet.offsetTop + anchor.localOffset * newScale / anchor.scale);
  }, [zoom, viewerWidth, pageSizes]);

  const adjustZoom = (direction: number) => {
    const current = zoom === 'fit'
      ? pageScale(displayPageSize(pageNumber), 'fit', viewerWidth)
      : zoom;
    changeZoom(Math.max(0.4, Math.min(2.5, Math.round((current + direction * 0.2) * 10) / 10)));
  };

  return <div className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) => /\.(pdf|docx|png|jpe?g|webp)$/i.test(item.name));
    if (file) void openPath(window.aster.pathForFile(file));
    else setError('Drop a PDF, DOCX, or image file to open it.');
  }}>
    <header className="topbar">
      <div className="brand"><img src="./icon.png" alt="" /><span>Aster<span className="brand-pdf">PDF</span></span></div>
      <div className="topbar-divider" />
      <div className="document-title" title={source?.path}>{source ? <><FileText size={17} /><strong>{source.name}</strong>{busy ? <span className="saving-spinner" role="status" aria-label={compressionProgress || 'Working'} title={compressionProgress || 'Working'} /> : (drafts.length > 0 || editingDirty || source.needsSave) && <span className="unsaved-dot" title="Unsaved changes" />}</> : <span>No document open</span>}</div>
      <div className="topbar-actions">
        <button className="button subtle" onClick={() => setSettingsOpen(true)} title="Comment author settings"><Settings2 size={18} /><span>Settings</span></button>
        <button className="button subtle" onClick={() => void openSelected()} disabled={busy}><FolderOpen size={18} /><span>Open file</span></button>
        <button className="button primary" onClick={() => void save()} disabled={!source || (!drafts.length && !editingDirty && !source.needsSave) || busy}><Save size={17} /><span>{busy ? 'Working…' : 'Save PDF'}</span></button>
      </div>
    </header>

    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}

    {!source ? <main className={`welcome ${recentPdfs.length ? 'has-recents' : ''}`}>
      <div className="welcome-mark"><img src="./icon.png" alt="" /></div>
      <span className="eyebrow">YOUR OFFLINE PDF WORKSPACE</span>
      <h1>Every detail, in view.</h1>
      <p>Open a PDF, Word document, or image. Organize pages, sign, compress, comment, and save as PDF — all offline.</p>
      <button className="button primary welcome-open" onClick={() => void openSelected()}><FolderOpen size={20} /> Open a file <ChevronRight size={18} /></button>
      <div className="drop-hint">or drop a PDF, DOCX, PNG, JPEG, or WebP anywhere in this window</div>
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
          <div className="toolbar-group page-control"><button className="icon-button" onClick={() => scrollToPage(Math.max(1, pageNumber - 1))} disabled={pageNumber <= 1} aria-label="Previous page"><ChevronLeft size={18} /></button><span><strong>{pageNumber}</strong><i>/</i>{document ? effectivePages.length : '…'}</span><button className="icon-button" onClick={() => scrollToPage(Math.min(effectivePages.length, pageNumber + 1))} disabled={pageNumber >= effectivePages.length} aria-label="Next page"><ChevronRight size={18} /></button></div>
          <div className="toolbar-group zoom-control"><button className="icon-button" onClick={() => adjustZoom(-1)} aria-label="Zoom out"><Minus size={17} /></button><button className="zoom-label" onClick={() => changeZoom('fit')}>{zoomValue}</button><button className="icon-button" onClick={() => adjustZoom(1)} aria-label="Zoom in"><Plus size={17} /></button></div>
          <div className="toolbar-spacer" />
          <button className="button outline tool-action" onClick={() => void addFiles()} disabled={!document || busy || drafts.length > 0}><Files size={16} />Add files</button>
          <button className="button outline tool-action" onClick={() => setCompressionOpen(true)} disabled={!document || busy || drafts.length > 0}><Shrink size={16} />Compress</button>
          <div className="signature-picker"><button className={`button ${placingSignatureId ? 'placing-button' : 'outline'} tool-action`} onClick={startSignature} disabled={!document || busy || drafts.length > 0} aria-expanded={signatureMenuOpen} aria-haspopup="menu"><PenLine size={16} />{placingSignatureId ? 'Place signature…' : 'Sign'}</button>
            {signatureMenuOpen && <div className="signature-dropdown" role="menu" aria-label="Saved signatures">
              {savedSignatures.length ? savedSignatures.map((signature) => <div className="signature-option" key={signature.id}>
                <button role="menuitem" onClick={() => chooseSignature(signature.id)}><img src={signature.dataUrl} alt="" /><span>{signature.name}</span></button>
                <button className="signature-option-delete" title={`Remove ${signature.name}`} aria-label={`Remove ${signature.name}`} onClick={() => { setSignatureMenuOpen(false); setPendingSignatureRemoval({ kind: 'saved', id: signature.id, name: signature.name }); }}><X size={14} /></button>
              </div>) : <p className="signature-empty">No saved signatures yet</p>}
              <button className="signature-add" role="menuitem" onClick={openNewSignature}>+ Signature</button>
            </div>}
          </div>
          <button className={`button ${placing ? 'placing-button' : 'outline'} tool-action`} onClick={startComment} disabled={!document || busy || editingDirty || placedSignatures.length > 0} title={editingDirty || placedSignatures.length ? 'Save edits before adding comments' : 'Add comment'}><MessageSquare size={17} />{placing ? 'Click on page…' : 'Comment'}</button>
        </div>
        <div className="viewer-scroll" ref={viewerRef}>
          <div className="page-wrap">
            {!document && <div className="loading-page">Opening PDF…</div>}
            {document && effectivePages.map((planned, index) => {
              const page = index + 1;
              return <PdfPage key={planned.id} document={document} pageNumber={page} sourcePageNumber={planned.sourceIndex + 1} rotation={planned.turns * 90}
                size={displayPageSize(page)}
                zoom={zoom} viewerWidth={viewerWidth} viewerRef={viewerRef}
                comments={commentsByPage.get(page) ?? EMPTY_COMMENTS} selectedId={selectedId}
                placing={placing} pendingPoint={pendingPoint} pageId={planned.id}
                signatures={placedSignatures.filter((signature) => signature.pageId === planned.id)} selectedSignatureId={selectedSignatureId} placingSignature={activeSignature}
                registerPage={registerPage} onMeasure={measurePage} onPlace={choosePoint}
                onAddSignature={addSignatureAt} onUpdateSignature={updateSignature} onSelectSignature={setSelectedSignatureId} onDeleteSignature={requestSignatureRemoval}
                onSelectComment={(id) => { setSelectedId(id); setSidebarTab('comments'); }}
                onError={reportPageError} />;
            })}
          </div>
        </div>
        <div className="viewer-footer"><span>{compressionProgress || source.path}</span><span>{document ? effectivePages.length : '…'} pages · Offline</span></div>
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
        </> : <div className="pages-panel"><div className="sidebar-heading"><div><h2>Pages</h2><p>{selectedPages.size ? `${selectedPages.size} selected` : 'Drag pages to sort, or use the arrows.'}</p></div></div>
          <div className="page-selection"><button onClick={() => setSelectedPages(new Set(Array.from({ length: effectivePages.length }, (_, index) => index)))}>Select all</button><button onClick={() => setSelectedPages(new Set())} disabled={!selectedPages.size}>Clear</button></div>
          <div className="page-tools" aria-label="Selected page actions">
            <button title="Undo edit" aria-label="Undo edit" disabled={busy || drafts.length > 0 || !historyPast.length} onClick={undoEdit}><Undo2 size={16} /></button>
            <button title="Redo edit" aria-label="Redo edit" disabled={busy || drafts.length > 0 || !historyFuture.length} onClick={redoEdit}><Redo2 size={16} /></button>
            <button title="Move page up" aria-label="Move page up" disabled={busy || drafts.length > 0 || selectedIndices.every((index) => index === 0)} onClick={() => applySelection('move-up')}><ArrowUp size={16} /></button>
            <button title="Move page down" aria-label="Move page down" disabled={busy || drafts.length > 0 || selectedIndices.every((index) => index === effectivePages.length - 1)} onClick={() => applySelection('move-down')}><ArrowDown size={16} /></button>
            <button title="Rotate left" aria-label="Rotate left" disabled={busy || drafts.length > 0} onClick={() => applySelection('rotate-left')}><RotateCcw size={16} /></button>
            <button title="Rotate right" aria-label="Rotate right" disabled={busy || drafts.length > 0} onClick={() => applySelection('rotate-right')}><RotateCw size={16} /></button>
            <button title="Duplicate page" aria-label="Duplicate page" disabled={busy || drafts.length > 0} onClick={() => applySelection('duplicate')}><Copy size={16} /></button>
            <button title="Delete page" aria-label="Delete page" disabled={busy || drafts.length > 0 || selectedIndices.length >= effectivePages.length} onClick={() => applySelection('delete')}><Trash2 size={16} /></button>
          </div>
          <div className="page-list">{effectivePages.map((planned, index) => <div key={planned.id} draggable={!busy && !drafts.length} className={`page-row ${pageNumber === index + 1 ? 'active' : ''}`}
            onDragStart={(event) => { dragPageRef.current = index; event.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(event) => { if (dragPageRef.current !== null) { event.preventDefault(); event.stopPropagation(); } }}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const from = dragPageRef.current; dragPageRef.current = null; if (from !== null && from !== index) void applyEdit({ type: 'move', from, to: index }); }}
            onDragEnd={() => { dragPageRef.current = null; }}>
            <input type="checkbox" aria-label={`Select page ${index + 1}`} checked={selectedPages.has(index)} onChange={() => setSelectedPages((previous) => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; })} />
            <button onClick={() => scrollToPage(index + 1)}>{document && <PageThumbnail document={document} page={planned.sourceIndex + 1} rotation={planned.turns * 90} />}<span>Page {index + 1}</span><small>{commentsByPage.get(index + 1)?.length || ''}</small></button>
            <button className="page-insert" aria-label={`Add files after page ${index + 1}`} title="Add files after this page" disabled={busy || drafts.length > 0} onClick={() => void addFiles(index)}><FilePlus2 size={15} /></button>
          </div>)}</div>
          <div className="sidebar-bottom"><Files size={16} /><button className="text-button" onClick={() => void addFiles()} disabled={busy || drafts.length > 0}>Add PDF, Word, or images</button></div>
        </div>}
      </aside>
    </main>}

    {compressionOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCompressionOpen(false); }}><div className="settings-modal feature-modal" role="dialog" aria-modal="true" aria-labelledby="compression-title"><div className="modal-head"><div className="modal-icon"><Shrink size={21} /></div><button onClick={() => setCompressionOpen(false)} aria-label="Close compression"><X size={19} /></button></div><h2 id="compression-title">Compress PDF</h2><p>Choose how to reduce the file. Save the result after checking the preview.</p><div className="compression-options">
      <button onClick={() => void runCompression('lossless')}><strong>Lossless</strong><span>Repack PDF objects. Keeps searchable text and comments; size may stay the same.</span></button>
      <button onClick={() => void runCompression('balanced')}><strong>Balanced</strong><span>Render pages at 140 DPI with good image quality.</span></button>
      <button onClick={() => void runCompression('small')}><strong>Smallest</strong><span>Render pages at 90 DPI with stronger compression.</span></button>
    </div><p className="compression-warning">Balanced and Smallest flatten pages into images. Searchable text, links, form fields, and comments will no longer be interactive in the saved copy. Use Save As to keep the original.</p></div></div>}
    {signatureOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSignatureOpen(false); }}><div className="settings-modal feature-modal" role="dialog" aria-modal="true" aria-labelledby="signature-title"><div className="modal-head"><div className="modal-icon"><PenLine size={21} /></div><button onClick={() => setSignatureOpen(false)} aria-label="Close signature"><X size={19} /></button></div><h2 id="signature-title">Add signature</h2><p>Draw below or import a PNG, JPEG, WebP, or SVG. Your signatures stay on this computer.</p><canvas className="signature-canvas" ref={signatureCanvasRef} width={1500} height={510}
      onPointerDown={(event) => signaturePointer(event, true)} onPointerMove={(event) => signaturePointer(event, false)} onPointerUp={finishSignature} onPointerCancel={finishSignature} />
      <div className="signature-controls"><button className={signatureInk === '#172333' ? 'active' : ''} onClick={() => setSignatureInk('#172333')}>Black</button><button className={signatureInk === '#204fb3' ? 'active' : ''} onClick={() => setSignatureInk('#204fb3')}>Blue</button><button onClick={() => { signatureCanvasRef.current?.getContext('2d')?.clearRect(0, 0, 1500, 510); signatureStrokesRef.current = []; setNewSignature(null); }}>Clear</button><button onClick={() => signatureImportRef.current?.click()}>Import image or SVG</button><input ref={signatureImportRef} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => { void importSignatureFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
      {newSignature && <div className="signature-preview"><span>Preview</span><img src={newSignature.dataUrl} alt="New signature preview" /></div>}
      <label htmlFor="signature-name">Name</label><input id="signature-name" value={newSignatureName} maxLength={40} onChange={(event) => setNewSignatureName(event.target.value)} placeholder="My signature" />
      <div className="modal-actions"><button className="button subtle" onClick={() => setSignatureOpen(false)}>Cancel</button><button className="button primary" disabled={!newSignature} onClick={useSignature}>Save signature</button></div></div></div>}
    {pendingSignatureRemoval && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingSignatureRemoval(null); }}><div className="settings-modal confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="remove-signature-title" aria-describedby="remove-signature-description">
      <h2 id="remove-signature-title">Remove signature?</h2>
      <p id="remove-signature-description">{pendingSignatureRemoval.kind === 'saved'
        ? `Remove “${pendingSignatureRemoval.name ?? 'this signature'}” from your saved signatures? Signatures already placed in the PDF will stay.`
        : 'Remove this placed signature from the current PDF? It has not been saved yet.'}</p>
      <div className="modal-actions"><button className="button subtle" autoFocus onClick={() => setPendingSignatureRemoval(null)}>Cancel</button><button className="button danger" onClick={confirmSignatureRemoval}>Remove signature</button></div>
    </div></div>}
    {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-head"><div className="modal-icon"><Settings2 size={21} /></div><button onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={19} /></button></div><h2 id="settings-title">Comment author</h2><p>This name appears on comments you add to PDF files. It is saved only on this computer.</p><label htmlFor="author-name">Your name</label><input id="author-name" autoFocus value={authorInput} onChange={(event) => setAuthorInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveSettings(); }} placeholder="Enter your name" maxLength={80} /><div className="modal-actions"><button className="button subtle" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="button primary" onClick={() => void saveSettings()} disabled={!authorInput.trim()}>Save settings</button></div></div></div>}
  </div>;
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ChevronLeft, ChevronRight, CircleHelp, FilePlus2, FileText,
  FolderOpen, MessageSquare, Minus, Plus, Save, Settings2, X, Presentation,
  ArrowUp, ArrowDown, Check, Copy, Trash2, RotateCcw, RotateCw, PenLine, Files, Shrink, Undo2, Redo2, Maximize2, GripVertical, TriangleAlert,
  Pencil, Paintbrush, Eraser, Square, Circle, MousePointer2, Type, ImagePlus, PanelRight,
  Bold, Italic, Underline, Strikethrough, AlignLeft, AlignCenter, AlignRight, AlignJustify, Eye, EyeOff, Highlighter, Link2, TextSelect
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { addTextNotes, changeComments, readAllPageComments, noteAsComment, commentThreads, inMarkupThread, markupKind, MARKUP_COLORS, type MarkupKind, type TextMarkupSelection, type CommentChange, type CommentOverride, type NewNote, type PdfComment } from './pdf/comments';
import { selectedPdfText } from './components/PdfTextSelection';
import { captureMarkups, restoreMarkupOverrides, type MarkupSnapshot } from './pdf/markup-history';
import { prepareCommentSave } from './pdf/comment-save';
import type { OpenedPdf, RecentPdf, WordExportResult } from './types';
import type { OpenedFile } from './types';
import PdfPage, { pageScale, type PageSize, type PendingPoint, type Zoom } from './components/PdfPage';
import PresentationView from './components/PresentationView';
import PageThumbnail from './components/PageThumbnail';
import { convertToPdf } from './import/convert';
import { appendPdfs, composePagePlan, compressPdf, embedSignatures, type CompressionLevel, type PageEdit, type SignatureDraw } from './pdf/edit';
import { changePagePlan, initialPagePlan, remapPageSelection, type PlannedPage } from './pdf/page-plan';
import { cropSignature, importSignature, loadSignatures, storeSignatures, type PlacedSignature, type SavedSignature, type SignatureStroke } from './signatures/library';
import { signatureDrawFromViewport } from './signatures/placement';
import { attachOverlayPackage, embedOverlays, isDrawingObject, readOverlayPackage, textSize, type OverlayObject, type TextAppearance } from './pdf/overlays';
import type { OverlayTool, PendingImage } from './components/OverlayLayer';
import FontPicker, { type ColorCommand, type FontCommand, type FontSelection, type InstalledFont } from './components/FontPicker';
import ColorPicker from './components/ColorPicker';
import DrawInspector, { layerName, NumberField, type DrawStyle } from './components/DrawInspector';
import SmartJustifyIcon from './components/SmartJustifyIcon';
import { prepareTextForExport, textOverlaySize } from './components/text-overlay-size';
import { resolveTextFont } from './components/OriginalTextEditor';
import UpdateSettings from './components/UpdateSettings';
import AboutDialog from './components/AboutDialog';
import SaveFeedback, { paintSaveFeedback } from './components/SaveFeedback';
import CommentCard from './components/CommentCard';
import CommentEditor from './components/CommentEditor';
import { sameComment, trimComment, type BoldRanges } from './pdf/comment-text';
import ResizableSidebar from './components/ResizableSidebar';
import { HyperlinkDialog, HyperlinkMenu } from './components/HyperlinkTools';
import { addPdfLinks } from './pdf/links';
import { useUpdates } from './updates';
import { finishInlineEdits } from './finish-inline-edit';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

type SidebarTab = 'comments' | 'pages' | 'draw';
type ActiveTool = SidebarTab | 'edit' | 'draw' | 'sign' | 'compress' | 'files';
const DEFAULT_PAGE_SIZE: PageSize = { width: 612, height: 792 };
const EMPTY_COMMENTS: PdfComment[] = [];
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
const COMPRESSION_PRESETS: { level: CompressionLevel; label: string; description: string }[] = [
  { level: 'lossless', label: 'Lossless', description: 'Repack PDF objects. Keeps searchable text and comments.' },
  { level: 'balanced', label: 'Balanced', description: 'Render pages at 140 DPI with good image quality.' },
  { level: 'small', label: 'Smallest', description: 'Render pages at 90 DPI with stronger compression.' }
];
type EditorSnapshot = { bytes: Uint8Array; plan: PlannedPage[] | null; pageCount: number; overlays: OverlayObject[] };
type CompressionEstimate =
  | { status: 'idle' }
  | { status: 'calculating'; progress: string }
  | { status: 'ready'; originalSize: number; sizes: Record<CompressionLevel, number>; sampledPages: number }
  | { status: 'error'; message: string };

function formatFileSize(bytes: number): string {
  const unit = bytes >= 1024 * 1024 ? 'MB' : 'KB';
  const divisor = unit === 'MB' ? 1024 * 1024 : 1024;
  return `${(bytes / divisor).toFixed(bytes / divisor < 10 ? 1 : 0)} ${unit}`;
}

function remember(history: EditorSnapshot[], snapshot: EditorSnapshot): EditorSnapshot[] {
  const next = [...history, snapshot].slice(-20);
  const usage = () => [...new Set(next.map((item) => item.bytes))].reduce((total, bytes) => total + bytes.byteLength, 0);
  while (next.length > 1 && usage() > MAX_HISTORY_BYTES) next.shift();
  return next;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function originalTextError(error: unknown): string {
  return messageOf(error).replace(/^Error invoking remote method 'pdf:replace-original-text': Error: /, '');
}

function displayDate(value?: string): string {
  if (!value) return '';
  const parsed = value.startsWith('D:') ? pdfjs.PDFDateString.toDateObject(value) : new Date(value);
  return !parsed || Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined, {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function commentLabel(comment: PdfComment): string {
  return comment.text || '(Empty note)';
}

export default function App() {
  const updates = useUpdates();
  const [externalOpen, setExternalOpen] = useState<{ id: string; path: string } | null>(null);
  const externalOpeningRef = useRef(false);
  useEffect(() => window.aster.onExternalOpen(setExternalOpen), []);
  const [preparingInstall, setPreparingInstall] = useState(false);
  const [installError, setInstallError] = useState('');
  const installLockRef = useRef(false);
  const installing = updates.state?.transfer.phase === 'installing';
  useEffect(() => {
    installLockRef.current = preparingInstall || installing;
    const blockKeys = (event: KeyboardEvent) => {
      if (installLockRef.current) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', blockKeys, true);
    return () => window.removeEventListener('keydown', blockKeys, true);
  }, [preparingInstall, installing]);
  const [source, setSourceState] = useState<OpenedPdf | null>(null);
  const [previewSource, setPreviewSource] = useState<OpenedPdf | null>(null);
  const [presenting, setPresenting] = useState(false);
  const presentationStarting = useRef(false);
  const presentationScroll = useRef<number | null>(null);
  useEffect(() => window.aster.onPresentationChanged(setPresenting), []);
  const exitPresentation = useCallback(() => {
    setPresenting(false);
    void window.aster.setPresentation(false);
  }, []);
  // Keep large binary buffers out of component props. React's development
  // profiler enumerates changed object props, including every PDF byte.
  const getSourceBytes = useCallback(() => {
    if (!source) throw new Error('No PDF is open.');
    return source.bytes;
  }, [source?.bytes]);
  const markupHistoryRef = useRef<{ past: MarkupSnapshot[]; future: MarkupSnapshot[]; colorGroup: string | null }>({ past: [], future: [], colorGroup: null });
  const setSource = useCallback((next: OpenedPdf | null) => {
    setSourceState(next); setPreviewSource(next);
    setCommentOverrides({});
    markupHistoryRef.current = { past: [], future: [], colorGroup: null };
  }, []);
  const [recentPdfs, setRecentPdfs] = useState<RecentPdf[]>([]);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const documentTasksRef = useRef(new WeakMap<PDFDocumentProxy, ReturnType<typeof pdfjs.getDocument>>());
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('comments');
  const [activeTool, setActiveTool] = useState<ActiveTool>('comments');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pageGridOpen, setPageGridOpen] = useState(false);
  const [gridDragOver, setGridDragOver] = useState<number | null>(null);
  const [comments, setComments] = useState<PdfComment[]>([]);
  const [savedSessionComments, setSavedSessionComments] = useState<PdfComment[]>([]);
  const [drafts, setDrafts] = useState<NewNote[]>([]);
  const [commentChanges, setCommentChanges] = useState<CommentChange[]>([]);
  const [commentOverrides, setCommentOverrides] = useState<Record<string, CommentOverride>>({});
  const [editingComment, setEditingComment] = useState<{ comment: PdfComment; text: string; bold?: BoldRanges } | null>(null);
  const pendingCommentCount = drafts.length + commentChanges.length;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [popupCommentId, setPopupCommentId] = useState<string | null>(null);
  const [markupTool, setMarkupTool] = useState<MarkupKind | null>(null);
  const [selectingLinks, setSelectingLinks] = useState(false);
  const [linkSelection, setLinkSelection] = useState<TextMarkupSelection[] | null>(null);
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; selection: TextMarkupSelection[] } | null>(null);
  useEffect(() => {
    if (activeTool !== 'edit') { setSelectingLinks(false); setLinkMenu(null); setLinkSelection(null); }
  }, [activeTool]);
  useEffect(() => { setLinkSelection(null); setLinkMenu(null); setSelectingLinks(false); }, [source?.path]);
  const [markupColors, setMarkupColors] = useState(MARKUP_COLORS);
  useEffect(() => {
    if (!selectedId) { setPopupCommentId(null); return; }
    const clearSelection = () => { setSelectedId(null); setPopupCommentId(null); setPendingCommentScroll(null); };
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && (target.closest('.comment-pin, .comment-popup, .sidebar-resize') ||
        target.closest('[data-comment-color]')?.getAttribute('data-comment-color') === selectedId ||
        target.closest<HTMLElement>('[data-comment-id]')?.dataset.commentId === selectedId)) return;
      clearSelection();
    };
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) clearSelection(); };
    globalThis.document.addEventListener('pointerdown', dismissOutside, true);
    globalThis.document.addEventListener('keydown', dismissOnEscape);
    return () => {
      globalThis.document.removeEventListener('pointerdown', dismissOutside, true);
      globalThis.document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [selectedId]);
  const [showCommentPins, setShowCommentPins] = useState(true);
  const [pendingCommentScroll, setPendingCommentScroll] = useState<string | null>(null);
  const commentListRef = useRef<HTMLDivElement>(null);
  const commentCardRefs = useRef(new Map<string, HTMLDivElement>());
  const [placing, setPlacing] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<PendingPoint | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteBold, setNoteBold] = useState<BoldRanges>([]);
  const [authorName, setAuthorName] = useState('');
  const [authorInput, setAuthorInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [discardRequestId, setDiscardRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commentSaving, setCommentSaving] = useState(false);
  const [returningHome, setReturningHome] = useState(false);
  const returningHomeRef = useRef(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [openingMessage, setOpeningMessage] = useState<string | null>(null);
  const openingRef = useRef<{ bytes?: Uint8Array; pdf?: PDFDocumentProxy } | null>(null);
  const finishOpening = useCallback(() => {
    openingRef.current = null;
    setOpeningMessage(null);
  }, []);
  const pageRendered = useCallback((pdf: PDFDocumentProxy, page: number) => {
    if (page === 1 && openingRef.current?.pdf === pdf) finishOpening();
  }, [finishOpening]);
  const [wordExporting, setWordExporting] = useState<'word' | 'data' | null>(null);
  const [wordExportResult, setWordExportResult] = useState<(WordExportResult & { kind: 'word' | 'data' }) | null>(null);
  const [editingDirty, setEditingDirty] = useState(false);
  const [pagePlan, setPagePlan] = useState<PlannedPage[] | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [historyPast, setHistoryPast] = useState<EditorSnapshot[]>([]);
  const [historyFuture, setHistoryFuture] = useState<EditorSnapshot[]>([]);
  const [overlays, setOverlays] = useState<OverlayObject[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [overlayTool, setOverlayTool] = useState<OverlayTool>('select');
  const [overlayColor, setOverlayColor] = useState('#172333');
  const [recentColors, setRecentColors] = useState<string[]>(() => {
    try { const colors: unknown = JSON.parse(localStorage.getItem('asterpdf-recent-colors') || '[]');
      return Array.isArray(colors) ? [...new Set(colors.filter((value): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)).map((value) => value.toLowerCase()))].slice(0, 10) : []; }
    catch { return []; }
  });
  const [overlayLineWidth, setOverlayLineWidth] = useState(2);
  const [drawDefaults, setDrawDefaults] = useState<DrawStyle>({ color: '#172333', lineWidth: 2, fill: '#e7f0d9', radius: 0, opacity: 1 });
  const [drawPreview, setDrawPreview] = useState<{ id: string; patch: Partial<OverlayObject> } | null>(null);
  useEffect(() => { setDrawPreview(null); }, [selectedOverlayId]);
  const selectedOverlay = overlays.find((item) => item.id === selectedOverlayId && (activeTool === 'draw' || !isDrawingObject(item)));
  const visibleOverlays = drawPreview ? overlays.map((item) => item.id === drawPreview.id ? { ...item, ...drawPreview.patch } : item) : overlays;
  const drawSelection = selectedOverlay?.kind !== 'text' ? selectedOverlay : undefined;
  const currentDrawStyle = drawSelection ? { ...drawDefaults, ...drawSelection, fill: drawSelection.fill ?? null,
    fillHidden: drawSelection.fillHidden ?? false,
    radius: drawSelection.radius ?? 0, opacity: drawSelection.opacity ?? 1, ...(drawPreview?.id === drawSelection.id ? drawPreview.patch : {}) } : drawDefaults;
  const [overlayFontSize, setOverlayFontSize] = useState(16);
  const [overlayFontChoice, setOverlayFontChoice] = useState<OverlayObject['fontChoice']>('noto-sans');
  const [textAppearance, setTextAppearance] = useState<TextAppearance>({});
  const [overlayImage, setOverlayImage] = useState<PendingImage | null>(null);
  const [installedFonts, setInstalledFonts] = useState<InstalledFont[]>([]);
  const [fontsStatus, setFontsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const fontsPromiseRef = useRef<Promise<InstalledFont[]> | null>(null);
  const ensureInstalledFonts = useCallback(() => {
    if (!fontsPromiseRef.current) {
      setFontsStatus('loading');
      fontsPromiseRef.current = window.aster.listInstalledFonts().then((fonts) => {
        setInstalledFonts(fonts); setFontsStatus('ready'); return fonts;
      }).catch((cause) => {
        fontsPromiseRef.current = null; setFontsStatus('error'); throw cause;
      });
    }
    return fontsPromiseRef.current;
  }, []);
  const [fontEditing, setFontEditing] = useState<FontSelection | null>(null);
  const selectedText = selectedOverlay?.kind === 'text' ? selectedOverlay : undefined;
  const activeTextAppearance = selectedText && fontEditing?.overlayId !== selectedText.id ? selectedText : textAppearance;
  const activeTextFont = resolveTextFont(selectedText?.fontChoice || overlayFontChoice || 'noto-sans', '', selectedText?.text || '', installedFonts, activeTextAppearance);
  const canFormatText = !busy && !selectedText?.locked && Boolean(selectedText || fontEditing?.overlayId || (!fontEditing && overlayTool === 'text'));
  const textFontSelection: FontSelection | null = selectedText && fontEditing?.overlayId !== selectedText.id
    ? { pageId: selectedText.pageId, index: -1, overlayId: selectedText.id, fontName: 'Added text',
      choice: selectedText.fontChoice || 'helvetica', fontSize: textSize(selectedText), color: selectedText.color }
    : fontEditing || (overlayTool === 'text' ? { pageId: '', index: -1, overlayId: 'new', fontName: 'Added text', choice: overlayFontChoice || 'noto-sans' } : null);
  const [fontCommand, setFontCommand] = useState<FontCommand | null>(null);
  const [colorCommand, setColorCommand] = useState<ColorCommand | null>(null);
  const changeFontEditing = useCallback((selection: FontSelection | null) => {
    setFontEditing(selection);
    if (selection?.fontSize) setOverlayFontSize(Math.max(4, Math.min(500, selection.fontSize)));
    if (selection?.overlayId) setOverlayFontChoice(selection.choice as OverlayObject['fontChoice']);
    if (selection?.overlayId) setTextAppearance(selection.appearance || {});
    if (selection?.color) setOverlayColor(selection.color);
  }, []);
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
  const [pendingSignatureDiscard, setPendingSignatureDiscard] = useState(false);
  const [compressionOpen, setCompressionOpen] = useState(false);
  const [compressionChoice, setCompressionChoice] = useState<CompressionLevel | null>(null);
  const [compressionEstimate, setCompressionEstimate] = useState<CompressionEstimate>({ status: 'idle' });
  const [compressionError, setCompressionError] = useState('');
  const [compressionProgress, setCompressionProgress] = useState('');
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
  const signatureDrawingRef = useRef(false);
  const signatureStrokesRef = useRef<SignatureStroke[]>([]);
  const signatureImportRef = useRef<HTMLInputElement>(null);
  const overlayImageRef = useRef<HTMLInputElement>(null);
  const savedBytesRef = useRef<Uint8Array | null>(null);
  const savedFileBytesRef = useRef<Uint8Array | null>(null);
  const savingCommentIdsRef = useRef(new Set<string>());
  const dragPageRef = useRef<number | null>(null);
  const gridReturnScrollRef = useRef<number | null>(null);
  const gridJumpPageRef = useRef<number | null>(null);
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
  const estimateForRef = useRef<{ bytes: Uint8Array; plan: PlannedPage[] | null } | null>(null);
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
  useEffect(() => window.aster.onDiscardRequest(setDiscardRequestId), []);
  useEffect(() => {
    if (!discardRequestId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        window.aster.answerDiscardRequest(discardRequestId, false);
        setDiscardRequestId(null);
      } else if (event.key === 'Tab') {
        const buttons = window.document.querySelectorAll<HTMLButtonElement>('.discard-actions button');
        if (buttons.length !== 2) return;
        if (event.shiftKey && window.document.activeElement === buttons[0]) { event.preventDefault(); buttons[1].focus(); }
        else if (!event.shiftKey && window.document.activeElement === buttons[1]) { event.preventDefault(); buttons[0].focus(); }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [discardRequestId]);
  useEffect(() => { setSavedSignatures(loadSignatures()); }, []);
  useEffect(() => {
    if (activeTool !== 'edit' || fontsStatus !== 'idle') return;
    void ensureInstalledFonts().catch((cause) => setError(`Could not list system fonts: ${messageOf(cause)}`));
  }, [activeTool, fontsStatus, ensureInstalledFonts]);

  useEffect(() => {
    window.aster.getSettings().then((settings) => {
      setAuthorName(settings.authorName);
      setAuthorInput(settings.authorName);
    }).catch((cause) => setError(messageOf(cause)));
  }, []);

  useEffect(() => {
    window.aster.setDirty(pendingCommentCount > 0 || editingDirty || placedSignatures.length > 0 || Boolean(source?.needsSave) || Boolean(pendingPoint && noteText.trim()) || Boolean(editingComment && !sameComment(editingComment, editingComment.comment)));
  }, [pendingCommentCount, editingDirty, placedSignatures.length, source?.needsSave, pendingPoint, noteText, editingComment]);

  useEffect(() => {
    const element = viewerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewerWidth(element.clientWidth));
    observer.observe(element);
    setViewerWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [source, pageGridOpen]);

  useEffect(() => {
    const source = previewSource;
    setSavedSessionComments([]);
    if (!source) { setDocument(null); return; }
    let cancelled = false;
    let published = false;
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    let previewRenderTask: { cancel(): void } | undefined;
    const restoreScroll = restoreScrollRef.current;
    const refreshing = restoreScroll !== null;
    // Keep mounted pages, their pixels, and measured sizes during an edit.
    // Only opening another file should replace the viewer with its loading state.
    if (!refreshing) {
      setDocument(null);
      setComments([]);
      setPageSizes({});
      viewerRef.current?.scrollTo(0, 0);
    }
    setScanning(true);
    restoreScrollRef.current = null;
    (async () => {
      try {
        task = pdfjs.getDocument({ data: source.bytes.slice() });
        const pdf = await task.promise;
        if (cancelled) return;
        const first = await pdf.getPage(1);
        if (cancelled) return;
        const firstViewport = first.getViewport({ scale: 1 });
        measurePage(1, { width: firstViewport.width, height: firstViewport.height });
        documentTasksRef.current.set(pdf, task);
        if (openingRef.current?.bytes === source.bytes) {
          openingRef.current.pdf = pdf;
          setOpeningMessage('Rendering the first page…');
        }
        published = true;
        setDocument(pdf);
        if (!refreshing) setPageNumber(1);
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
        const nextComments: PdfComment[] = [];
        for (let page = 1; page <= pdf.numPages; page += 1) {
          if (cancelled) break;
          try {
            const pdfPage = await pdf.getPage(page);
            const natural = pdfPage.getViewport({ scale: 1 });
            if (!cancelled) measurePage(page, { width: natural.width, height: natural.height });
            nextComments.push(...await readAllPageComments(pdfPage, page));
            if (!cancelled && !refreshing) setComments([...nextComments]);
          } catch {
            if (!cancelled) setError(`Could not read comments on page ${page}.`);
          }
        }
        if (!cancelled) setComments(nextComments);
      } catch (cause) {
        if (!cancelled) {
          if (openingRef.current?.bytes === source.bytes) finishOpening();
          setError(`Could not open PDF: ${messageOf(cause)}`);
        }
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
      previewRenderTask?.cancel();
      // Published documents stay alive until React has replaced their pages.
      if (!published) void task?.destroy();
    };
  }, [previewSource, measurePage, refreshRecent, finishOpening]);

  useEffect(() => () => {
    if (document) {
      void documentTasksRef.current.get(document)?.destroy();
      documentTasksRef.current.delete(document);
    }
  }, [document]);

  useEffect(() => {
    setCompressionChoice(null);
    if (!source) { estimateForRef.current = null; setCompressionEstimate({ status: 'idle' }); return; }
    // Estimating every preset parses/renders the PDF too. Do this only when
    // requested, never alongside a background comment save on a large file.
    if (!compressionOpen) return;
    estimateForRef.current = { bytes: source.bytes, plan: pagePlan };
    setCompressionEstimate({ status: 'calculating', progress: 'Starting size estimates…' });
    const worker = new Worker(new URL('./pdf/compression-estimator.worker.ts', import.meta.url), { type: 'module' });
    let active = true;
    worker.onmessage = (event: MessageEvent<
      | { type: 'progress'; message: string }
      | { type: 'ready'; originalSize: number; sizes: Record<CompressionLevel, number>; sampledPages: number }
      | { type: 'error'; message: string }
    >) => {
      if (!active) return;
      const result = event.data;
      if (result.type === 'progress') setCompressionEstimate({ status: 'calculating', progress: result.message });
      else if (result.type === 'ready') setCompressionEstimate({ status: 'ready', originalSize: result.originalSize,
        sizes: result.sizes, sampledPages: result.sampledPages });
      else setCompressionEstimate({ status: 'error', message: result.message });
    };
    worker.onerror = (event) => {
      if (active) setCompressionEstimate({ status: 'error', message: event.message || 'Could not estimate compressed sizes.' });
    };
    const bytes = source.bytes.slice();
    worker.postMessage({ bytes, plan: pagePlan }, [bytes.buffer]);
    return () => { active = false; worker.terminate(); };
  }, [source?.bytes, pagePlan, compressionOpen]);

  const effectivePages = useMemo(() => document ? (pagePlan ?? initialPagePlan(document.numPages)) : [], [document, pagePlan]);
  const visibleComments = useMemo(() => pagePlan
    ? pagePlan.flatMap((page, index) => [...comments, ...savedSessionComments].filter((comment) => comment.page === page.sourceIndex + 1)
      .map((comment) => ({ ...comment, id: `${page.id}:${comment.id}`, replyTo: comment.replyTo ? `${page.id}:${comment.replyTo}` : undefined, page: index + 1 })))
    : [...comments, ...savedSessionComments], [comments, savedSessionComments, pagePlan]);

  const allComments = useMemo(() => [
    ...visibleComments,
    ...drafts.map(note => noteAsComment(note, true))
  ].flatMap((comment) => {
    const override = commentOverrides[comment.id];
    return override?.deleted ? [] : [{ ...comment, ...override }];
  }).sort((a, b) => a.page - b.page), [visibleComments, drafts, commentOverrides]);
  // Unannotated text markups belong on the page, not in the conversation.
  const threads = useMemo(() => commentThreads(allComments), [allComments]);
  const threadComments = useMemo(() => [...visibleComments, ...drafts.map(note => noteAsComment(note))], [visibleComments, drafts]);
  const conversationComments = threads.filter(comment => !markupKind(comment.kind) || comment.text.trim() || comment.replies?.length);
  const listedComments = threads.filter(comment => !markupKind(comment.kind) || comment.text.trim() || comment.replies?.length || editingComment?.comment.id === comment.id);
  useLayoutEffect(() => {
    if (!pendingCommentScroll || sidebarCollapsed || sidebarTab !== 'comments') return;
    const list = commentListRef.current;
    const card = commentCardRefs.current.get(pendingCommentScroll);
    if (!list || !card) return;
    const bounds = list.getBoundingClientRect(), target = card.getBoundingClientRect();
    if (target.top < bounds.top + 8 || target.bottom > bounds.bottom - 8) {
      // Scroll only the comment list, never the PDF viewer or the whole app.
      list.scrollTo({
        top: Math.max(0, list.scrollTop + target.top - bounds.top - Math.max(8, (list.clientHeight - target.height) / 2)),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      });
    }
    setPendingCommentScroll(null);
  }, [pendingCommentScroll, sidebarCollapsed, sidebarTab, allComments]);
  const commentsByPage = useMemo(() => {
    const grouped = new Map<number, PdfComment[]>();
    for (const comment of threads) {
      const current = grouped.get(comment.page) ?? [];
      current.push(comment);
      grouped.set(comment.page, current);
    }
    return grouped;
  }, [threads]);

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
  }, [document, effectivePages.length, pageGridOpen]);

  useLayoutEffect(() => {
    if (pageGridOpen || !viewerRef.current) return;
    const position = gridReturnScrollRef.current;
    const target = gridJumpPageRef.current;
    if (position === null && target === null) return;
    gridReturnScrollRef.current = null;
    gridJumpPageRef.current = null;
    const frame = requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const sheet = target === null ? null : pageRefs.current.get(target);
      viewer.scrollTop = sheet ? Math.max(0, sheet.offsetTop - 20) : (position ?? 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [pageGridOpen]);

  const scrollToPage = useCallback((target: number) => {
    const viewer = viewerRef.current;
    const sheet = pageRefs.current.get(target);
    if (!viewer || !sheet) return;
    viewer.scrollTo({ top: Math.max(0, sheet.offsetTop - 20), behavior: 'smooth' });
  }, []);

  const jumpToComment = useCallback(async (comment: PdfComment) => {
    setPopupCommentId(null);
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
      const imported = await convertToPdf(opened);
      const editable = opened.kind === 'pdf' ? await readOverlayPackage(imported) : null;
      // Editable objects replace the flattened PDF text in our preview. Resolve
      // their fonts before showing them, even when opening in Comments mode.
      const restoredText = editable?.objects.filter((item) => item.kind === 'text') ?? [];
      const fonts = restoredText.some((item) => item.fontChoice?.startsWith('system:')) ? await ensureInstalledFonts() : [];
      const fontSpecs = new Set(restoredText.map((item) => {
        const style = resolveTextFont(item.fontChoice || 'helvetica', '', item.text || '', fonts, item);
        return `${style.fontStyle} ${style.fontWeight} ${textSize(item)}px ${style.family}`;
      }));
      await Promise.all([...fontSpecs].map((spec) => window.document.fonts.load(spec)));
      const bytes = editable?.base ?? imported;
      if (openingRef.current) {
        openingRef.current.bytes = bytes;
        setOpeningMessage('Preparing the first page…');
      }
      restoreScrollRef.current = null;
      gridReturnScrollRef.current = null;
      gridJumpPageRef.current = null;
      setPageGridOpen(false);
      setGridDragOver(null);
      setDrafts([]);
      setCommentChanges([]); setEditingComment(null);
      setEditingDirty(false);
      setPagePlan(null);
      savedBytesRef.current = bytes;
      savedFileBytesRef.current = imported;
      setSelectedPages(new Set());
      setPlacedSignatures([]);
      setOverlays(editable?.objects ?? []);
      setSelectedOverlayId(null);
      setSelectedSignatureId(null);
      setPendingSignatureRemoval(null);
      setPendingSignatureDiscard(false);
      setPlacingSignatureId(null);
      setSignatureMenuOpen(false);
      setHistoryPast([]);
      setHistoryFuture([]);
      setCompressionOpen(false);
      setCompressionError('');
      setCompressionEstimate({ status: 'calculating', progress: 'Starting size estimates…' });
      setCompressionChoice(null);
      setSource({ path: opened.path, name: opened.kind === 'pdf' ? opened.name : opened.name.replace(/\.[^.]+$/, '.pdf'), bytes, needsSave: opened.kind !== 'pdf' });
      setSelectedId(null);
      setPendingPoint(null);
      setPlacing(false);
      setError('');
      void refreshRecent();
      return true;
    } catch (cause) {
      setSource(null);
      setDrafts([]);
      setCommentChanges([]); setEditingComment(null);
      setEditingDirty(false);
      setPagePlan(null);
      setPageGridOpen(false);
      setPlacedSignatures([]);
      setOverlays([]);
      setSelectedOverlayId(null);
      setSelectedSignatureId(null);
      setPendingSignatureRemoval(null);
      setPendingSignatureDiscard(false);
      setPlacingSignatureId(null);
      window.aster.setDirty(false);
      setError(`Could not open file: ${messageOf(cause)}`);
      return false;
    }
    finally { setBusy(false); }
  }, [refreshRecent, ensureInstalledFonts]);

  const openSelected = useCallback(async () => {
    if (returningHomeRef.current || openingRef.current) return;
    if (savingRef.current) { setError('Please wait for the PDF to finish saving.'); return; }
    try {
      const opened = await window.aster.openDialog();
      if (opened) await installOpened(opened);
    } catch (cause) { setError(messageOf(cause)); }
  }, [installOpened]);

  const openPath = useCallback(async (filePath: string) => {
    if (returningHomeRef.current || openingRef.current) return;
    if (savingRef.current) { setError('Please wait for the PDF to finish saving.'); return; }
    openingRef.current = {};
    setOpeningMessage('Reading your file…');
    let installed = false;
    try {
      await paintSaveFeedback();
      const opened = await window.aster.openPath(filePath);
      if (opened) {
        setOpeningMessage('Preparing your PDF…');
        await paintSaveFeedback();
        installed = await installOpened(opened);
      }
    } catch (cause) { setError(messageOf(cause)); }
    finally { if (!installed) finishOpening(); }
  }, [installOpened, finishOpening]);

  const goHome = async () => {
    if (!source || busy || savingRef.current || returningHomeRef.current || installLockRef.current) return;
    returningHomeRef.current = true;
    setReturningHome(true);
    try {
      await finishInlineEdits();
      if (!(await window.aster.closeDocument(source.path))) return;
      setSource(null);
      setDrafts([]); setEditingDirty(false); setPagePlan(null);
      setCommentChanges([]); setEditingComment(null);
      setComments([]); setSavedSessionComments([]); setSelectedId(null); setPendingCommentScroll(null);
      setPendingPoint(null); setNoteText(''); setNoteBold([]); setPlacing(false);
      setOverlays([]); setSelectedOverlayId(null); setDrawPreview(null); setOverlayImage(null);
      setPlacedSignatures([]); setSelectedSignatureId(null); setPlacingSignatureId(null);
      setSignatureMenuOpen(false); setSignatureOpen(false);
      setPendingSignatureRemoval(null); setPendingSignatureDiscard(false);
      setHistoryPast([]); setHistoryFuture([]); setSelectedPages(new Set());
      setPageGridOpen(false); setGridDragOver(null); setPageNumber(1);
      setCompressionOpen(false); setCompressionChoice(null); setCompressionError('');
      setCompressionEstimate({ status: 'idle' });
      setActiveTool('comments'); setSidebarTab('comments'); setSidebarCollapsed(false);
      setFontEditing(null); setSettingsOpen(false); setError('');
      savedBytesRef.current = null; savedFileBytesRef.current = null;
      restoreScrollRef.current = null; gridReturnScrollRef.current = null; gridJumpPageRef.current = null;
      void refreshRecent();
    } catch (cause) { setError(`Could not return to Home: ${messageOf(cause)}`); }
    finally { returningHomeRef.current = false; setReturningHome(false); }
  };

  useEffect(() => {
    if (!externalOpen || externalOpeningRef.current || busy || commentSaving || returningHome || preparingInstall || installing ||
      signatureOpen || compressionOpen || discardRequestId || pendingSignatureRemoval || pendingSignatureDiscard) return;
    externalOpeningRef.current = true;
    const request = externalOpen;
    void (async () => {
      try {
        // Reopening the same file should focus the window without resetting edits.
        if (source?.path === request.path) return;
        setSettingsOpen(false);
        await Promise.resolve();
        await finishInlineEdits();
        await openPath(request.path);
      } catch (cause) { setError(`Could not open file: ${messageOf(cause)}`); }
      finally {
        setExternalOpen(null);
        externalOpeningRef.current = false;
        window.aster.completeExternalOpen(request.id);
      }
    })();
  }, [externalOpen, busy, commentSaving, returningHome, preparingInstall, installing, signatureOpen, compressionOpen, discardRequestId,
    pendingSignatureRemoval, pendingSignatureDiscard, source?.path, openPath]);

  const buildPendingPdf = useCallback(async (additionalNotes: NewNote[] = []): Promise<{ bytes: Uint8Array; base: Uint8Array; objects: OverlayObject[] }> => {
    if (!source) throw new Error('Open a PDF first.');
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
    const overlayPages = await Promise.all(effectivePages.map(async (planned, index) => {
      const page = await document!.getPage(planned.sourceIndex + 1);
      const natural = page.getViewport({ scale: 1 });
      return { pageId: planned.id, index, viewport: page.getViewport({ scale: 1, rotation: natural.rotation + planned.turns * 90 }) };
    }));
    const notes = [...drafts, ...additionalNotes];
    const base = await changeComments(notes.length ? await addTextNotes(signed, notes) : signed, commentChanges);
    const visibleIds = new Map(effectivePages.map((planned, index) => [planned.id, `source-${index}`]));
    const sizedOverlays = overlays.map((item) => {
      const target = overlayPages.find((page) => page.pageId === item.pageId);
      return item.kind === 'text' && target ? { ...item, ...textOverlaySize(item, target.viewport.width, target.viewport.height, installedFonts) } : item;
    });
    const objects = sizedOverlays.flatMap((item) => visibleIds.has(item.pageId) ? [{ ...item, pageId: visibleIds.get(item.pageId)! }] : []);
    const exportObjects = (await Promise.all(sizedOverlays.map((item) => {
      const target = overlayPages.find((page) => page.pageId === item.pageId);
      return target ? prepareTextForExport(item, installedFonts, target.viewport.width, target.viewport.height) : Promise.resolve([]);
    }))).flat();
    let annotated = await embedOverlays(base, exportObjects, overlayPages);
    const shaped = exportObjects.flatMap((item) => {
      if (item.hidden || item.kind !== 'text' || !item.text || !(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(item.text) || item.fontChoice === 'noto-naskh-arabic')) return [];
      const target = overlayPages.find((page) => page.pageId === item.pageId);
      if (!target) return [];
      const view = target.viewport;
      const size = textSize(item);
      const left = item.x * view.width + (item.width * view.width - (item.textAdvance ?? item.width * view.width)) * (item.textAlign === 'center' ? .5 : item.textAlign === 'right' ? 1 : 0);
      const [x, y] = view.convertToPdfPoint(left, item.y * view.height + size);
      const [rightX, rightY] = view.convertToPdfPoint(left + 10, item.y * view.height + size);
      const angle = Math.atan2(rightY - y, rightX - x);
      const color = [1, 3, 5].map((offset) => Number.parseInt(item.color.slice(offset, offset + 2), 16));
      const shear = item.italic ? Math.tan(Math.PI / 15) : 0;
      return [{ pageIndex: target.index, text: item.text, size, fontChoice: item.fontChoice, bold: item.bold,
        matrix: [Math.cos(angle), Math.sin(angle), -Math.sin(angle) + shear * Math.cos(angle), Math.cos(angle) + shear * Math.sin(angle), x, y], color }];
    });
    if (shaped.length) annotated = await window.aster.embedShapedText(annotated, shaped);
    return { bytes: await attachOverlayPackage(annotated, base, objects), base, objects };
  }, [source, pagePlan, placedSignatures, effectivePages, document, drafts, commentChanges, overlays, installedFonts]);

  const latestWordBuild = useRef(buildPendingPdf);
  useLayoutEffect(() => { latestWordBuild.current = buildPendingPdf; }, [buildPendingPdf]);
  const exportDocument = useCallback(async (kind: 'word' | 'data') => {
    if (!source || !document) { setError('Open a PDF before exporting its content.'); return; }
    if (busy || savingRef.current || returningHomeRef.current || installLockRef.current) return;
    savingRef.current = true;
    window.aster.setSaving(true);
    let prepared: { token: string; path: string } | null = null;
    let unsubscribe: (() => void) | undefined;
    try {
      // Ask for the destination before any conversion or expensive preparation.
      prepared = await (kind === 'data' ? window.aster.prepareDataExport : window.aster.prepareWordExport)(source.path);
      if (!prepared) return;
      await finishInlineEdits();
      setBusy(true); setWordExporting(kind); setWordExportResult(null);
      window.aster.setSaving(true);
      setSaveMessage('Preparing the current PDF…');
      await paintSaveFeedback();
      unsubscribe = (kind === 'data' ? window.aster.onDataProgress : window.aster.onWordProgress)(progress => {
        if (progress.token === prepared?.token) setSaveMessage(progress.message);
      });
      const additionalNotes: NewNote[] = pendingPoint && noteText.trim() && authorName ? [{
        id: crypto.randomUUID(), page: pendingPoint.page, x: pendingPoint.x, y: pendingPoint.y,
        author: authorName, ...trimComment({ text: noteText, bold: noteBold }), date: new Date().toISOString(), replyTo: pendingPoint.replyTo
      }] : [];
      const { bytes } = await latestWordBuild.current(additionalNotes);
      const result = await (kind === 'data' ? window.aster.convertToData : window.aster.convertToWord)(bytes, prepared.token, source.path);
      setWordExportResult({ ...result, kind }); setError('');
    } catch (cause) {
      setError(`Could not ${kind === 'data' ? 'extract PDF data' : 'convert PDF to Word'}: ${messageOf(cause)}`);
    } finally {
      unsubscribe?.();
      if (prepared) await (kind === 'data' ? window.aster.discardDataExport : window.aster.discardWordExport)(prepared.token).catch(() => {});
      savingRef.current = false;
      window.aster.setSaving(false);
      setBusy(false); setSaveMessage(null); setWordExporting(null);
    }
  }, [source, document, busy, pendingPoint, noteText, noteBold, authorName]);

  const save = useCallback(async (saveAs = false, additionalNotes: NewNote[] = []): Promise<boolean> => {
    if (returningHomeRef.current) return false;
    if (savingRef.current) return false;
    if (!source || (!saveAs && pendingCommentCount === 0 && !additionalNotes.length && !editingDirty && !placedSignatures.length && !source.needsSave)) return true;
    const savedIds = new Set(drafts.map((note) => note.id));
    const savedChangeIds = new Set(commentChanges.map((change) => change.operationId));
    savingRef.current = true;
    window.aster.setSaving(true);
    setBusy(true);
    try {
      setSaveMessage('Preparing your pages and edits…');
      await paintSaveFeedback();
      const { bytes, base, objects } = await buildPendingPdf(additionalNotes);
      setSaveMessage('Saving your changes…');
      const saved = await window.aster.save(bytes, saveAs || Boolean(source.needsSave), source.path);
      if (saved) {
        restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
        setDrafts((current) => current.filter((note) => !savedIds.has(note.id)));
        setCommentChanges((current) => current.filter((change) => !savedChangeIds.has(change.operationId)));
        setEditingDirty(false);
        setPagePlan(null);
        setPlacedSignatures([]);
        setOverlays(objects);
        setSelectedOverlayId(null);
        setSelectedSignatureId(null);
        setPlacingSignatureId(null);
        setHistoryPast([]);
        setHistoryFuture([]);
        savedBytesRef.current = base;
        savedFileBytesRef.current = bytes;
        setSource({ ...saved, bytes: base });
        if (additionalNotes.length) { setPendingPoint(null); setNoteText(''); setNoteBold([]); }
        window.aster.setDirty(false);
        setError('');
        void refreshRecent();
        return true;
      }
      return false;
    } catch (cause) {
      setError(`Could not save PDF: ${messageOf(cause)}`);
      return false;
    } finally {
      savingRef.current = false;
      window.aster.setSaving(false);
      setSaveMessage(null);
      setBusy(false);
    }
  }, [source, drafts, commentChanges, pendingCommentCount, editingDirty, placedSignatures.length, buildPendingPdf, refreshRecent]);
  const latestSave = useRef(save);
  useLayoutEffect(() => { latestSave.current = save; }, [save]);

  useEffect(() => window.aster.onPrepareDocument(async mode => {
    if (busy || openingRef.current || savingRef.current || returningHomeRef.current) {
      setError('Please wait for this document to finish its current operation.');
      return false;
    }
    setAboutOpen(false); setSettingsOpen(false); setLinkSelection(null);
    await finishInlineEdits();
    // Flush text edits and their dirty notification before the main process
    // decides whether this tab needs an unsaved-changes prompt.
    await paintSaveFeedback();
    if (mode === 'close') return true;
    if (editingComment && !sameComment(editingComment, editingComment.comment)) {
      setError('Finish editing this comment before installing the update.');
      return false;
    }
    const pendingNotes: NewNote[] = pendingPoint && noteText.trim() ? [{
      id: crypto.randomUUID(), page: pendingPoint.page, x: pendingPoint.x, y: pendingPoint.y,
      author: authorName, ...trimComment({ text: noteText, bold: noteBold }), date: new Date().toISOString(), replyTo: pendingPoint.replyTo
    }] : [];
    if (pendingNotes.length && !authorName) { setError('Set your comment author name before saving.'); return false; }
    const saved = await latestSave.current(false, pendingNotes);
    await paintSaveFeedback();
    return saved;
  }), [busy, editingComment, pendingPoint, noteText, noteBold, authorName]);

  const restartAndInstall = async () => {
    if (busy || savingRef.current || installLockRef.current) return;
    installLockRef.current = true;
    setPreparingInstall(true); setInstallError('');
    try {
      const pendingNotes: NewNote[] = pendingPoint && noteText.trim() ? [{
        id: crypto.randomUUID(), page: pendingPoint.page, x: pendingPoint.x, y: pendingPoint.y,
        author: authorName, ...trimComment({ text: noteText, bold: noteBold }), date: new Date().toISOString(), replyTo: pendingPoint.replyTo
      }] : [];
      if (pendingNotes.length && !authorName) throw new Error('Set your comment author name before saving this comment.');
      if (!(await save(false, pendingNotes))) {
        setInstallError('The PDF was not saved. AsterPDF will stay open. Save your changes, then try again.');
        return;
      }
      await window.aster.installUpdate();
    } catch (cause) { setInstallError(messageOf(cause)); }
    finally { installLockRef.current = false; setPreparingInstall(false); }
  };

  const applyEdit = useCallback(async (edit: PageEdit) => {
    if (!source || !document || busy || pendingCommentCount || pendingPoint) return;
    try {
      const current = pagePlan ?? initialPagePlan(document.numPages);
      const next = changePagePlan(current, edit);
      if (next.length === current.length && next.every((page, index) => page.id === current[index].id && page.turns === current[index].turns)) return;
      setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: current.length, overlays }));
      setHistoryFuture([]);
      window.aster.setDirty(true);
      setEditingDirty(true);
      setSelectedPages(remapPageSelection(current, next, selectedPages));
      setSelectedId(null);
      setPagePlan(next);
      if (edit.type === 'duplicate') {
        const copy = next[edit.page + 1]; const original = current[edit.page];
        setOverlays((items) => [...items, ...items.filter((item) => item.pageId === original.id).map((item) => ({ ...item, id: crypto.randomUUID(), pageId: copy.id }))]);
      }
      setPageNumber((page) => Math.min(page, next.length));
      setSidebarTab('pages');
      setActiveTool('pages');
      setError('');
    } catch (cause) { setError(`Could not edit pages: ${messageOf(cause)}`); }
  }, [source, document, pagePlan, selectedPages, busy, pendingCommentCount, pendingPoint, overlays]);

  const addFiles = useCallback(async (afterPage?: number) => {
    if (!source || busy || pendingCommentCount) return;
    try {
      const files = await window.aster.addDialog();
      if (!files?.length) return;
      setBusy(true);
      const additions: Uint8Array[] = [];
      for (const file of files) additions.push(await convertToPdf(file));
      const addedCount = afterPage === undefined ? 0 : (await Promise.all(additions.map(async (bytes) => (await PDFDocument.load(bytes)).getPageCount()))).reduce((sum, count) => sum + count, 0);
      const arranged = pagePlan ? await composePagePlan(source.bytes, pagePlan) : source.bytes;
      const bytes = await appendPdfs(arranged, additions, afterPage);
      setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length, overlays }));
      setHistoryFuture([]);
      window.aster.setDirty(true);
      setEditingDirty(true);
      setPlacedSignatures((current) => current.flatMap((placement) => {
        const index = effectivePages.findIndex((page) => page.id === placement.pageId);
        return index < 0 ? [] : [{ ...placement, pageId: `source-${index + (afterPage !== undefined && index > afterPage ? addedCount : 0)}` }];
      }));
      setOverlays((items) => items.flatMap((item) => {
        const index = effectivePages.findIndex((page) => page.id === item.pageId);
        return index < 0 ? [] : [{ ...item, pageId: `source-${index + (afterPage !== undefined && index > afterPage ? addedCount : 0)}` }];
      }));
      setPagePlan(null);
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes });
      setSidebarTab('pages');
      setActiveTool('pages');
      setSidebarCollapsed(false);
      setError('');
    } catch (cause) { setError(`Could not add files: ${messageOf(cause)}`); }
    finally { setBusy(false); }
  }, [source, pagePlan, effectivePages, busy, pendingCommentCount, overlays]);

  const saveCompressedCopy = useCallback(async () => {
    if (!source || !compressionChoice || busy || savingRef.current || pendingCommentCount) return;
    savingRef.current = true;
    window.aster.setSaving(true);
    setBusy(true);
    setCompressionProgress('Choose a location for the compressed copy…');
    let token: string | null = null;
    try {
      const destination = await window.aster.prepareCompressedSave(source.path);
      if (!destination) return;
      token = destination.token;
      setCompressionProgress('Preparing PDF pages and signatures…');
      setSaveMessage('Preparing your compressed PDF…');
      await paintSaveFeedback();
      const prepared = (await buildPendingPdf()).bytes;
      setCompressionProgress(compressionChoice === 'lossless' ? 'Repacking PDF objects…' : 'Starting page compression…');
      const bytes = await compressPdf(prepared, compressionChoice,
        (page, total, stage) => setCompressionProgress(stage === 'starting'
          ? `Compressing page ${page} of ${total} (${Math.round((page - 1) / total * 100)}%)…`
          : `Finished page ${page} of ${total} (${Math.round(page / total * 100)}%)…`));
      if (bytes.byteLength >= prepared.byteLength) throw new Error('This preset did not make the PDF smaller. Try another option.');
      setCompressionProgress('Writing compressed PDF…');
      const saved = await window.aster.finishCompressedSave(bytes, token, source.path);
      token = null;
      const editableCopy = await readOverlayPackage(bytes);
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setDrafts([]);
      setEditingDirty(false);
      setPagePlan(null);
      setPlacedSignatures([]);
      setOverlays(editableCopy?.objects ?? []);
      setSelectedOverlayId(null);
      setSelectedSignatureId(null);
      setPlacingSignatureId(null);
      setHistoryPast([]);
      setHistoryFuture([]);
      savedBytesRef.current = editableCopy?.base ?? bytes;
      savedFileBytesRef.current = bytes;
      setSource({ ...saved, bytes: editableCopy?.base ?? bytes });
      setCompressionOpen(false);
      setCompressionChoice(null);
      setError('');
      void refreshRecent();
    } catch (cause) {
      const message = `Could not save compressed PDF: ${messageOf(cause)}`;
      setCompressionError(message);
      setError(message);
    }
    finally {
      if (token) await window.aster.discardCompressedSave(token).catch(() => {});
      savingRef.current = false;
      window.aster.setSaving(false);
      setSaveMessage(null);
      setBusy(false);
      setCompressionProgress('');
    }
  }, [source, compressionChoice, busy, pendingCommentCount, buildPendingPdf, refreshRecent]);

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
    if (!remaining.length && !pagePlan && source?.bytes === savedBytesRef.current) setEditingDirty(false);
  }, [placedSignatures, pagePlan, source]);

  const discardPendingSignatures = useCallback(() => {
    setPlacedSignatures([]);
    setSelectedSignatureId(null);
    setPlacingSignatureId(null);
    setSignatureMenuOpen(false);
    setPendingSignatureDiscard(false);
    if (!pagePlan && source?.bytes === savedBytesRef.current) setEditingDirty(false);
  }, [pagePlan, source]);

  const requestSignatureRemoval = useCallback((id: string) => {
    setPendingSignatureRemoval({ kind: 'placed', id });
  }, []);

  const captureMarkupState = useCallback(() => captureMarkups(drafts, commentChanges, commentOverrides, [...comments, ...savedSessionComments]),
    [drafts, commentChanges, commentOverrides, comments, savedSessionComments]);

  const rememberMarkup = useCallback((colorId?: string, commit = true) => {
    const history = markupHistoryRef.current;
    // A continuous drag in the color picker is a single undo step.
    if (!colorId || history.colorGroup !== colorId) {
      history.past = [...history.past, captureMarkupState()].slice(-100);
      history.future = [];
    }
    history.colorGroup = colorId && !commit ? colorId : null;
  }, [captureMarkupState]);

  const restoreMarkupHistory = useCallback((direction: 'undo' | 'redo') => {
    if (!source || busy || returningHome || editingDirty || placedSignatures.length || pagePlan) return;
    const history = markupHistoryRef.current;
    const from = direction === 'undo' ? history.past : history.future;
    const target = from.pop();
    if (!target) return;
    const current = captureMarkupState();
    if (direction === 'undo') history.future = [...history.future, current].slice(-100);
    else history.past = [...history.past, current].slice(-100);
    history.colorGroup = null;
    setDrafts(notes => [...notes.filter(note => !current.ids.includes(note.id)), ...target.drafts]);
    setCommentChanges(changes => [...changes.filter(change => !current.ids.includes(change.target.id)), ...target.changes]);
    setCommentOverrides(overrides => restoreMarkupOverrides(overrides, current, target));
    setSelectedId(null); setPopupCommentId(null); setPendingCommentScroll(null); setEditingComment(null);
    window.getSelection()?.removeAllRanges();
  }, [source, busy, returningHome, editingDirty, placedSignatures.length, pagePlan, captureMarkupState]);

  const undoEdit = useCallback(() => {
    if (!source || busy || pendingCommentCount || !historyPast.length) return;
    const previous = historyPast[historyPast.length - 1];
    setHistoryPast((history) => history.slice(0, -1));
    setHistoryFuture((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length, overlays }));
    const dirty = previous.bytes !== savedBytesRef.current || previous.plan !== null || previous.overlays.length > 0;
    setEditingDirty(dirty);
    window.aster.setDirty(dirty || Boolean(source.needsSave));
    const currentPages = pagePlan ?? initialPagePlan(effectivePages.length);
    const previousPages = previous.plan ?? initialPagePlan(previous.pageCount);
    setSelectedPages(remapPageSelection(currentPages, previousPages, selectedPages));
    setPagePlan(previous.plan);
    setOverlays(previous.overlays);
    setSelectedOverlayId(null);
    if (previous.bytes !== source.bytes) {
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes: previous.bytes });
    }
  }, [source, pagePlan, effectivePages.length, selectedPages, busy, pendingCommentCount, historyPast, overlays]);

  const redoEdit = useCallback(() => {
    if (!source || busy || pendingCommentCount || !historyFuture.length) return;
    const next = historyFuture[historyFuture.length - 1];
    setHistoryFuture((history) => history.slice(0, -1));
    setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length, overlays }));
    const dirty = next.bytes !== savedBytesRef.current || next.plan !== null || next.overlays.length > 0;
    setEditingDirty(dirty);
    window.aster.setDirty(dirty || Boolean(source.needsSave));
    const currentPages = pagePlan ?? initialPagePlan(effectivePages.length);
    const nextPages = next.plan ?? initialPagePlan(next.pageCount);
    setSelectedPages(remapPageSelection(currentPages, nextPages, selectedPages));
    setPagePlan(next.plan);
    setOverlays(next.overlays);
    setSelectedOverlayId(null);
    if (next.bytes !== source.bytes) {
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes: next.bytes });
    }
  }, [source, pagePlan, effectivePages.length, selectedPages, busy, pendingCommentCount, historyFuture, overlays]);

  useEffect(() => {
    const isEditingText = (element: Element | null) => element instanceof HTMLElement && (
      element.isContentEditable || element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type))
    );
    const historyAction = (direction: 'undo' | 'redo') => {
      if (installLockRef.current) return;
      const focused = window.document.activeElement;
      if (isEditingText(focused)) {
        window.document.execCommand(direction);
        return;
      }
      if (window.document.querySelector('.modal-backdrop')) return;
      const markupHistory = markupHistoryRef.current;
      if (activeTool === 'comments' || (!editingDirty && (markupHistory.past.length > 0 || markupHistory.future.length > 0))) {
        restoreMarkupHistory(direction);
        return;
      }
      if (direction === 'undo') undoEdit(); else redoEdit();
    };
    const unsubscribeUndo = window.aster.onMenu('menu:undo', () => historyAction('undo'));
    const unsubscribeRedo = window.aster.onMenu('menu:redo', () => historyAction('redo'));
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) ||
        (event.key.toLowerCase() !== 'z' && event.code !== 'KeyZ')) return;
      const focused = window.document.activeElement;
      if (isEditingText(focused)) return;
      event.preventDefault();
      historyAction(event.shiftKey ? 'redo' : 'undo');
    };
    window.document.addEventListener('keydown', keyDown, true);
    return () => { unsubscribeUndo(); unsubscribeRedo(); window.document.removeEventListener('keydown', keyDown, true); };
  }, [undoEdit, redoEdit, activeTool, editingDirty, restoreMarkupHistory]);

  useEffect(() => {
    const deselect = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('[data-overlay-id], .overlay-toolbar, .draw-inspector, .sidebar-toggle, .image-context-menu, .added-text-editor, [data-added-text-controls], [data-font-picker]'))
        setSelectedOverlayId(null);
    };
    window.document.addEventListener('pointerdown', deselect, true);
    return () => window.document.removeEventListener('pointerdown', deselect, true);
  }, []);

  const commitOverlays = useCallback((next: OverlayObject[]) => {
    if (!source || busy || pendingCommentCount) return;
    setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length, overlays }));
    setHistoryFuture([]);
    setOverlays(next);
    setEditingDirty(true);
    window.aster.setDirty(true);
  }, [source, busy, pendingCommentCount, pagePlan, effectivePages.length, overlays]);
  const commitOriginalText = useCallback(async (pageIndex: number, objectIndex: number, oldText: string, nextText: string, fontChoice: string, color?: number[]) => {
    if (!source || busy || pendingCommentCount || (oldText === nextText && fontChoice === 'original' && !color)) return;
    setBusy(true);
    window.aster.setSaving(true);
    try {
      const bytes = await window.aster.replaceOriginalText(source.bytes, pageIndex, objectIndex, oldText, nextText, fontChoice, color);
      setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length, overlays }));
      setHistoryFuture([]);
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes });
      setEditingDirty(true);
      window.aster.setDirty(true);
      setError('');
    } catch (cause) { setError(`Could not edit original PDF text: ${originalTextError(cause)}`); }
    finally { setBusy(false); window.aster.setSaving(false); }
  }, [source, busy, pendingCommentCount, pagePlan, effectivePages.length, overlays]);
  const moveOriginalText = useCallback(async (pageIndex: number, objectIndex: number, text: string, dx: number, dy: number) => {
    if (!source || busy || pendingCommentCount) return;
    setBusy(true);
    window.aster.setSaving(true);
    try {
      const bytes = await window.aster.moveOriginalText(source.bytes, pageIndex, objectIndex, text, dx, dy);
      setHistoryPast((history) => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length, overlays }));
      setHistoryFuture([]);
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes });
      setEditingDirty(true);
      window.aster.setDirty(true);
      setError('');
    } catch (cause) { setError(`Could not move original PDF text: ${originalTextError(cause)}`); }
    finally { setBusy(false); window.aster.setSaving(false); }
  }, [source, busy, pendingCommentCount, pagePlan, effectivePages.length, overlays]);
  const startHyperlink = async (selection = selectedPdfText()) => {
    if (busy || pendingCommentCount || pagePlan) return;
    setLinkMenu(null);
    try {
      await finishInlineEdits();
      if (!selection.length) {
        setSelectingLinks(true); setOverlayTool('select'); setSelectedOverlayId(null);
      } else setLinkSelection(selection);
    } catch (cause) { setError(`Could not prepare hyperlink: ${messageOf(cause)}`); }
  };
  const applyHyperlink = async (url: string) => {
    if (!source || !linkSelection || busy || pendingCommentCount || pagePlan) throw new Error('Save pending comment or page changes before adding a link.');
    setBusy(true); window.aster.setSaving(true);
    try {
      const bytes = await addPdfLinks(source.bytes, linkSelection, url);
      setHistoryPast(history => remember(history, { bytes: source.bytes, plan: pagePlan, pageCount: effectivePages.length, overlays }));
      setHistoryFuture([]);
      restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
      setSource({ ...source, bytes }); setEditingDirty(true); window.aster.setDirty(true);
      setLinkSelection(null); setSelectingLinks(false); window.getSelection()?.removeAllRanges();
    } finally { setBusy(false); window.aster.setSaving(false); }
  };
  const addOverlay = (object: OverlayObject) => { commitOverlays([...overlays, { ...object, editingTool: object.editingTool ?? (activeTool === 'draw' ? 'draw' : 'edit') }]); setSelectedOverlayId(object.id);
    if (object.kind === 'image' || ['rectangle', 'ellipse', 'line'].includes(object.kind)) { setOverlayTool('select'); setOverlayImage(null); } };
  const updateOverlay = (object: OverlayObject) => {
    const previous = overlays.find((item) => item.id === object.id);
    if (previous && isDrawingObject(previous) && activeTool !== 'draw') return;
    if (!previous || Object.entries(object).every(([key, value]) => previous[key as keyof OverlayObject] === value)) return;
    commitOverlays(overlays.map((item) => item.id === object.id ? object : item));
  };
  const deleteOverlay = (id: string) => {
    const object = overlays.find((item) => item.id === id);
    if (object && isDrawingObject(object) && activeTool !== 'draw') return;
    commitOverlays(overlays.filter((item) => item.id !== id)); setSelectedOverlayId(null);
  };
  const selectOverlay = (id: string | null) => {
    const object = overlays.find((item) => item.id === id);
    if (object && isDrawingObject(object) && activeTool !== 'draw') return;
    setSelectedOverlayId(id);
    const selected = overlays.find((item) => item.id === id);
    if (selected) {
      setOverlayColor(selected.color); setOverlayLineWidth(selected.lineWidth);
      if (selected.kind === 'text') {
        setOverlayFontSize(textSize(selected)); setOverlayFontChoice(selected.fontChoice || 'helvetica');
        setTextAppearance({ bold: selected.bold, italic: selected.italic, underline: selected.underline, strikeThrough: selected.strikeThrough, textAlign: selected.textAlign, textSizing: selected.textSizing });
      }
      if (selected.kind !== 'text' && selected.kind !== 'image') setDrawDefaults({ color: selected.color, lineWidth: selected.lineWidth,
        fill: selected.fill ?? null, fillHidden: selected.fillHidden ?? false, opacity: selected.opacity ?? 1, radius: selected.radius ?? 0 });
    }
  };
  const chooseDrawingTool = (tool: OverlayTool) => { setOverlayTool(tool); if (tool !== 'select') setSelectedOverlayId(null); };
  const rememberDrawColor = (color: string) => setRecentColors((colors) => {
    const next = [color, ...colors.filter((value) => value !== color)].slice(0, 10);
    try { localStorage.setItem('asterpdf-recent-colors', JSON.stringify(next)); } catch { /* Optional history. */ }
    return next;
  });
  const changeDrawStyle = (patch: Partial<DrawStyle>, commit = true) => {
    if (drawSelection?.locked || busy) return;
    if (!commit && drawSelection) { setDrawPreview({ id: drawSelection.id, patch }); return; }
    setDrawDefaults((previous) => ({ ...previous, ...patch }));
    if (commit) {
      setDrawPreview(null);
      if (drawSelection) updateOverlay({ ...drawSelection, ...patch });
      if (patch.color) rememberDrawColor(patch.color);
      if (patch.fill) rememberDrawColor(patch.fill);
    }
  };
  const duplicateOverlay = () => {
    if (!drawSelection || drawSelection.locked) return;
    const size = displayPageSize(effectivePages.findIndex((item) => item.id === drawSelection.pageId) + 1);
    addOverlay({ ...drawSelection, id: crypto.randomUUID(), name: `${layerName(drawSelection)} copy`,
      x: drawSelection.x + 12 / size.width, y: drawSelection.y + 12 / size.height });
  };
  const orderOverlay = (id: string, direction: string) => {
    const object = overlays.find((item) => item.id === id);
    if (!object || object.locked) return;
    const siblings = overlays.filter((item) => item.pageId === object.pageId && item.kind !== 'text');
    const index = siblings.indexOf(object);
    const target = direction === 'forward' ? siblings[index + 1] : direction === 'backward' ? siblings[index - 1] : siblings.find((item) => item.id === direction);
    if (!target || target === object) return;
    const next = overlays.filter((item) => item.id !== id);
    next.splice(next.indexOf(target) + (siblings.indexOf(target) > index ? 1 : 0), 0, object);
    commitOverlays(next);
  };
  useEffect(() => {
    if (activeTool !== 'draw' || busy || settingsOpen || signatureOpen || compressionOpen || discardRequestId) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"]'))) return;
      if (event.key === 'Escape') { setSelectedOverlayId(null); setDrawPreview(null); setOverlayTool('select'); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateOverlay(); return; }
      if (event.ctrlKey || event.metaKey) return;
      if (drawSelection && !drawSelection.locked && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault(); deleteOverlay(drawSelection.id); return;
      }
      if (drawSelection && !drawSelection.locked && event.key.startsWith('Arrow')) {
        event.preventDefault();
        const size = displayPageSize(effectivePages.findIndex((item) => item.id === drawSelection.pageId) + 1);
        const step = event.shiftKey ? 10 : 1;
        const next = { ...drawSelection, x: drawSelection.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0) / size.width,
          y: drawSelection.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) / size.height };
        if (event.repeat) setOverlays((items) => items.map((item) => item.id === next.id ? next : item));
        else updateOverlay(next);
        return;
      }
      const shortcut = ({ v: 'select', r: 'rectangle', o: 'ellipse', l: 'line', p: 'pen', e: 'eraser' } as const)[event.key.toLowerCase() as 'v'];
      if (shortcut) { event.preventDefault(); chooseDrawingTool(shortcut); }
    };
    window.document.addEventListener('keydown', key);
    return () => window.document.removeEventListener('keydown', key);
  });
  const changeTextAppearance = (patch: TextAppearance) => {
    if (!canFormatText) return;
    setTextAppearance((previous) => ({ ...previous, ...patch }));
    if (!selectedText || fontEditing?.overlayId === selectedText.id) return;
    const updated = { ...selectedText, ...patch };
    const size = displayPageSize(effectivePages.findIndex((item) => item.id === updated.pageId) + 1);
    updateOverlay({ ...updated, ...textOverlaySize(updated, size.width, size.height, installedFonts) });
  };
  const changeOverlayFontSize = (value: number, commit = true) => {
    setOverlayFontSize(value);
    if (selectedOverlay?.kind !== 'text' || fontEditing?.overlayId === selectedOverlay.id) return;
    const size = displayPageSize(effectivePages.findIndex((item) => item.id === selectedOverlay.pageId) + 1);
    const updated = { ...selectedOverlay, fontSize: value };
    Object.assign(updated, textOverlaySize(updated, size.width, size.height, installedFonts));
    if (!commit) { setDrawPreview({ id: updated.id, patch: updated }); return; }
    setDrawPreview(null); updateOverlay(updated);
  };
  const chooseOverlayColor = (value: string, rememberColor = true) => {
    setOverlayColor(value);
    if (rememberColor) setRecentColors((colors) => { const next = [value, ...colors.filter((color) => color !== value)].slice(0, 10);
      try { localStorage.setItem('asterpdf-recent-colors', JSON.stringify(next)); } catch { /* Color history is optional. */ }
      return next; });
    const selected = overlays.find((item) => item.id === selectedOverlayId);
    if (fontEditing && !fontEditing.overlayId) setColorCommand((previous) => ({ pageId: fontEditing.pageId, index: fontEditing.index, color: value, sequence: (previous?.sequence || 0) + 1 }));
    else if (rememberColor && selected && !fontEditing?.overlayId && selected.color !== value) updateOverlay({ ...selected, color: value });
  };
  const importOverlayImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = window.document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();
      setOverlayImage({ dataUrl: canvas.toDataURL('image/png'), aspect: canvas.width / canvas.height });
      setSelectedOverlayId(null);
      setOverlayTool('image');
      if (activeTool !== 'draw') setActiveTool('edit');
    } catch (cause) { setError(`Could not insert image: ${messageOf(cause)}`); }
  };

  const selectedIndices = selectedPages.size ? [...selectedPages].sort((a, b) => a - b) : [pageNumber - 1];
  const applySelection = (action: Extract<PageEdit, { type: 'batch' }>['action']) =>
    void applyEdit({ type: 'batch', pages: selectedIndices, action });

  useEffect(() => {
    if (!source || busy || commentSaving || returningHome || savingRef.current || pendingCommentCount === 0 || autoSaveRevision <= lastAutoAttemptRef.current) return;
    // Coalesce quick submissions into one disk write without blocking typing.
    const timer = setTimeout(() => {
      if (savingRef.current || returningHomeRef.current) return;
      // Text markups stay pending until an explicit save, including when a
      // regular note triggers background saving in the same document.
      const batch = drafts.filter(note => !inMarkupThread(noteAsComment(note), threadComments));
      const changes = commentChanges.filter(change => !inMarkupThread(change.target, threadComments));
      if (!batch.length && !changes.length) return;
      if (source.needsSave) {
        lastAutoAttemptRef.current = autoSaveRevision;
        setError('Save this PDF once to choose its location and enable automatic comment saving.'); return;
      }
      if (!savedFileBytesRef.current || editingDirty || placedSignatures.length || pagePlan) return;
      lastAutoAttemptRef.current = autoSaveRevision;
      const changeIds = new Set(changes.map((change) => change.operationId));
      const ids = new Set(batch.map((note) => note.id));
      const snapshot = savedFileBytesRef.current;
      savingCommentIdsRef.current = new Set([...ids, ...changes.map((change) => change.target.id)]);
      savingRef.current = true;
      setCommentSaving(true);
      window.aster.setSaving(true);
      void (async () => {
        try {
          const { bytes, base } = await prepareCommentSave(snapshot, batch, changes);
          const saved = await window.aster.save(bytes, false, source.path);
          if (!saved) throw new Error('The comments were not saved.');
          savedFileBytesRef.current = bytes;
          savedBytesRef.current = base;
          // Only the data changes. Keep the current PDF renderer, scroll, tools,
          // selected note, and the next comment's composer exactly as they are.
          setSourceState({ ...source, ...saved, bytes: base });
          setSavedSessionComments((current) => [...current, ...batch.map(note => noteAsComment(note))]);
          setDrafts((current) => current.filter((note) => !ids.has(note.id)));
          setCommentChanges((current) => current.filter((change) => !changeIds.has(change.operationId)));
          if (changes.some((change) => change.target.kind !== 'Text note' && !markupKind(change.target.kind) && (change.type === 'delete' || change.target.kind === 'Free text'))) {
            // Visible PDF markup needs a fresh bitmap; sticky notes only need the
            // interactive pin/list update and never interrupt the page renderer.
            restoreScrollRef.current = viewerRef.current?.scrollTop ?? 0;
            setPreviewSource({ ...source, ...saved, bytes: base });
          }
          // The dirty-state effect accounts for newer comments and an unfinished
          // composer; never clear it unconditionally for an older saved batch.
          setError('');
        } catch (cause) {
          setError(`Could not auto-save comments: ${messageOf(cause)} Your comments are still here. Use Save PDF to retry.`);
        } finally {
          savingCommentIdsRef.current = new Set();
          savingRef.current = false;
          window.aster.setSaving(false);
          setCommentSaving(false);
        }
      })();
    }, 600);
    return () => clearTimeout(timer);
  }, [autoSaveRevision, busy, commentSaving, returningHome, drafts, commentChanges, pendingCommentCount, source, editingDirty, placedSignatures.length, pagePlan, threadComments]);

  useEffect(() => {
    const subscriptions = [
      window.aster.onMenu('menu:open', () => { if (!installLockRef.current) void openSelected(); }),
      window.aster.onMenu('menu:save', () => { if (!installLockRef.current) void finishInlineEdits().then(() => latestSave.current()).catch((cause) => setError(messageOf(cause))); }),
      window.aster.onMenu('menu:save-as', () => { if (!installLockRef.current) void finishInlineEdits().then(() => latestSave.current(true)).catch((cause) => setError(messageOf(cause))); }),
      window.aster.onMenu('menu:settings', () => { if (!installLockRef.current) setSettingsOpen(true); }),
      window.aster.onMenu('menu:about', () => { if (!installLockRef.current && !openingRef.current && !savingRef.current) setAboutOpen(true); }),
      window.aster.onMenu('menu:pdf-to-word', () => { void exportDocument('word'); }),
      window.aster.onMenu('menu:pdf-to-data', () => { void exportDocument('data'); })
    ];
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [openSelected, save, exportDocument]);

  const saveSettings = async () => {
    try {
      const settings = await window.aster.setAuthorName(authorInput);
      setAuthorName(settings.authorName);
      setAuthorInput(settings.authorName);
      setSettingsOpen(false);
      setError('');
    } catch (cause) { setError(messageOf(cause)); }
  };

  const answerDiscard = (discard: boolean) => {
    if (!discardRequestId) return;
    window.aster.answerDiscardRequest(discardRequestId, discard);
    setDiscardRequestId(null);
  };

  const startComment = () => {
    if (pendingPoint?.replyTo && noteText.trim()) { setError('Post or cancel your current reply before starting a new comment.'); return; }
    if (editingDirty || placedSignatures.length) { setError('Save your edits before adding a comment so only the comment is auto-saved.'); return; }
    if (!authorName) { setSettingsOpen(true); return; }
    setMarkupTool(null);
    setSidebarTab('comments');
    setActiveTool('comments');
    setSidebarCollapsed(false);
    setPlacingSignatureId(null);
    setPlacing((value) => !value);
    setPendingPoint(null);
    setNoteText(''); setNoteBold([]);
  };

  const addTextMarkup = useCallback((kind: MarkupKind, selections: TextMarkupSelection[]) => {
    if (!selections.length || !source || busy || returningHome || editingDirty || placedSignatures.length || pagePlan) return;
    if (!authorName) { setSettingsOpen(true); return; }
    const notes: NewNote[] = selections.map(selection => ({
      id: crypto.randomUUID(), page: selection.page, x: selection.quadPoints[0], y: selection.quadPoints[1],
      author: authorName, text: '', date: new Date().toISOString(),
      markup: { kind, quadPoints: selection.quadPoints, color: markupColors[kind] }
    }));
    rememberMarkup();
    window.aster.setDirty(true);
    setDrafts(current => [...current, ...notes]);
    setSelectedId(notes[notes.length - 1].id); setPopupCommentId(notes[notes.length - 1].id);
    window.getSelection()?.removeAllRanges();
  }, [source, busy, returningHome, editingDirty, placedSignatures.length, pagePlan, authorName, markupColors, rememberMarkup]);

  const chooseMarkupTool = (kind: MarkupKind) => {
    if (pendingPoint?.replyTo && noteText.trim()) { setError('Post or cancel your current reply before switching to a markup tool.'); return; }
    if (!authorName) { setSettingsOpen(true); return; }
    const selections = selectedPdfText();
    setPlacing(false); setPendingPoint(null); setPopupCommentId(null);
    setMarkupTool(current => current === kind && !selections.length ? null : kind);
    if (selections.length) addTextMarkup(kind, selections);
  };

  useEffect(() => {
    if (activeTool !== 'comments') { setMarkupTool(null); return; }
    if (!markupTool) return;
    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => addTextMarkup(markupTool, selectedPdfText()));
    };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Shift') apply(); };
    globalThis.document.addEventListener('pointerup', apply);
    globalThis.document.addEventListener('keyup', keyboard);
    return () => { cancelAnimationFrame(frame); globalThis.document.removeEventListener('pointerup', apply); globalThis.document.removeEventListener('keyup', keyboard); };
  }, [activeTool, markupTool, addTextMarkup]);

  const startSignature = () => { setActiveTool('sign'); setSignatureMenuOpen((open) => !open); setPlacing(false); };

  const openPageGrid = () => {
    gridReturnScrollRef.current = viewerRef.current?.scrollTop ?? 0;
    gridJumpPageRef.current = null;
    setPageGridOpen(true);
    setSidebarCollapsed(true);
  };

  const closePageGrid = (page?: number) => {
    gridJumpPageRef.current = page ?? null;
    setPageGridOpen(false);
    setGridDragOver(null);
    setSidebarCollapsed(false);
  };

  const selectTool = (tool: ActiveTool) => {
    if (pageGridOpen) setPageGridOpen(false);
    setSelectedOverlayId(null); setDrawPreview(null);
    setActiveTool(tool);
    setSignatureMenuOpen(false);
    if (tool !== 'comments') setPlacing(false);
    if (tool !== 'sign') setPlacingSignatureId(null);
    if (tool === 'edit') { setOverlayTool('select'); setSidebarTab('pages'); }
    if (tool === 'draw') { setOverlayTool('select'); setSelectedOverlayId(null); }
    if (tool === 'comments' || tool === 'pages' || tool === 'draw') {
      setSidebarTab(tool);
      setSidebarCollapsed(false);
    } else setSidebarCollapsed(true);
  };

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
      if (pendingSignatureRemoval || pendingSignatureDiscard) return;
      const target = event.target as Element;
      if (!target.closest('.signature-picker')) setSignatureMenuOpen(false);
      if (!target.closest('.editable-signature, .signature-context-menu')) setSelectedSignatureId(null);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (pendingSignatureDiscard) {
        if (event.key === 'Escape') setPendingSignatureDiscard(false);
        return;
      }
      if (pendingSignatureRemoval) {
        if (event.key === 'Escape') setPendingSignatureRemoval(null);
        return;
      }
      if (event.key === 'Escape') { setPlacingSignatureId(null); setSignatureMenuOpen(false); setSelectedSignatureId(null);
        setOverlayImage(null); setOverlayTool((tool) => tool === 'image' ? 'select' : tool); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedSignatureId &&
        !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) requestSignatureRemoval(selectedSignatureId);
    };
    window.document.addEventListener('pointerdown', outside);
    window.document.addEventListener('keydown', keyDown);
    return () => { window.document.removeEventListener('pointerdown', outside); window.document.removeEventListener('keydown', keyDown); };
  }, [selectedSignatureId, pendingSignatureRemoval, pendingSignatureDiscard, requestSignatureRemoval]);

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
    if (!pendingPoint || !noteText.trim() || !authorName || busy || returningHome || editingDirty || placedSignatures.length || pagePlan) return;
    if (pendingPoint.replyTo && !allComments.some(comment => comment.id === pendingPoint.replyTo)) {
      setError('This comment was removed. Cancel the reply or choose another comment.'); return;
    }
    const id = crypto.randomUUID();
    const manual = pendingPoint.replyTo && inMarkupThread(allComments.find(comment => comment.id === pendingPoint.replyTo)!, threadComments);
    if (manual) rememberMarkup();
    window.aster.setDirty(true);
    setDrafts((current) => [...current, {
      id, page: pendingPoint.page, x: pendingPoint.x, y: pendingPoint.y,
      author: authorName, ...trimComment({ text: noteText, bold: noteBold }), date: new Date().toISOString(), replyTo: pendingPoint.replyTo
    }]);
    if (!manual) setAutoSaveRevision((revision) => revision + 1);
    setSelectedId(pendingPoint.replyTo ?? id);
    setPendingCommentScroll(id);
    setPendingPoint(null);
    setNoteText(''); setNoteBold([]);
  };

  const startReply = (comment: PdfComment) => {
    if (!authorName) { setSettingsOpen(true); return; }
    const root = threads.find(item => item.id === comment.id || item.replies?.some(reply => reply.id === comment.id)) ?? comment;
    if (pendingPoint && noteText.trim()) {
      selectTool('comments');
      if (pendingPoint.replyTo !== root.id) setError('Post or cancel your current comment before starting another reply.');
      return;
    }
    selectTool('comments'); setMarkupTool(null); setPlacing(false); setPopupCommentId(null);
    setSelectedId(root.id); setPendingCommentScroll(root.id);
    setPendingPoint({ page: root.page, x: root.rect[0], y: root.rect[1], replyTo: root.id });
    setNoteText(''); setNoteBold([]);
  };

  const changeComment = (comment: PdfComment, type: 'edit' | 'delete', text?: string, bold?: BoldRanges) => {
    if (busy || returningHome || editingDirty || placedSignatures.length || pagePlan) return;
    const formatted = trimComment({ text: text || '', bold });
    if (type === 'edit' && (!formatted.text || sameComment(formatted, comment))) { setEditingComment(null); return; }
    if (inMarkupThread(comment, threadComments)) rememberMarkup();
    const date = new Date().toISOString();
    setCommentChanges((current) => [...current, { operationId: crypto.randomUUID(), target: comment, type, ...formatted, date }]);
    setCommentOverrides((current) => ({ ...current, [comment.id]: { ...current[comment.id], ...(type === 'delete' ? { deleted: true } : { ...formatted, date }) } }));
    if (!inMarkupThread(comment, threadComments)) setAutoSaveRevision((revision) => revision + 1);
    window.aster.setDirty(true);
    if (editingComment?.comment.id === comment.id) setEditingComment(null);
    if (type === 'delete' && selectedId === comment.id) setSelectedId(null);
  };

  const changeMarkupColor = (comment: PdfComment, color: string, remember = true) => {
    if (busy || returningHome || editingDirty || placedSignatures.length || pagePlan || !markupKind(comment.kind) || !/^#[0-9a-f]{6}$/i.test(color)) return;
    setMarkupColors(current => ({ ...current, [comment.kind]: color }));
    if (remember) rememberDrawColor(color);
    if (comment.color === color) {
      if (remember) markupHistoryRef.current.colorGroup = null;
      return;
    }
    rememberMarkup(comment.id, remember);
    const date = new Date().toISOString();
    setCommentChanges(current => [...current.filter(change => change.target.id !== comment.id || change.type !== 'color'),
      { operationId: crypto.randomUUID(), target: comment, type: 'color', color, date }]);
    setCommentOverrides(current => ({ ...current, [comment.id]: { ...current[comment.id], color, date } }));
    window.aster.setDirty(true);
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

  const visibleCompressionEstimate: CompressionEstimate = source &&
    (estimateForRef.current?.bytes !== source.bytes || estimateForRef.current.plan !== pagePlan)
    ? { status: 'calculating', progress: 'Starting size estimates…' } : compressionEstimate;

  const renderCommentEntry = (comment: PdfComment, root: PdfComment) => <CommentCard key={comment.id} comment={comment} selected={selectedId === comment.id}
    cardRef={(element) => { if (element) commentCardRefs.current.set(comment.id, element); else commentCardRefs.current.delete(comment.id); }}
    label={comment.text || (markupKind(comment.kind) ? comment.kind : commentLabel(comment))} date={displayDate(comment.date)} saving={savingCommentIdsRef.current.has(comment.id)}
    pending={Boolean(comment.draft) || commentChanges.some(change => change.target.id === comment.id)}
    disabled={busy || returningHome || editingDirty || placedSignatures.length > 0 || Boolean(pagePlan)}
    editingText={editingComment?.comment.id === comment.id ? editingComment.text : undefined}
    onSelect={() => void jumpToComment(root)} onReply={() => startReply(comment)}
    onEdit={() => { setPopupCommentId(null); setEditingComment({ comment, text: comment.text, bold: comment.bold }); setSelectedId(comment.id); }}
    editingBold={editingComment?.comment.id === comment.id ? editingComment.bold : undefined}
    onTextChange={(text, bold) => setEditingComment(current => current ? { ...current, text, bold } : null)}
    onSave={() => { if (editingComment) changeComment(editingComment.comment, 'edit', editingComment.text, editingComment.bold); }}
    onCancel={() => setEditingComment(null)} onDelete={() => changeComment(comment, 'delete')} />;

  const startPresentation = async () => {
    if (!document || busy || presentationStarting.current) return;
    presentationStarting.current = true;
    try {
      await finishInlineEdits();
      presentationScroll.current = viewerRef.current?.scrollTop ?? 0;
      setPresenting(true);
      await window.aster.setPresentation(true);
    } catch (cause) { setPresenting(false); setError(`Could not start presentation: ${messageOf(cause)}`); }
    finally { presentationStarting.current = false; }
  };

  useEffect(() => {
    if (presenting || presentationScroll.current === null) return;
    const top = presentationScroll.current;
    let frame = 0;
    // Fullscreen changes the viewer's measured width. Restore after its pages
    // have settled back to the normal window size, including native exits.
    const restore = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { if (viewerRef.current) viewerRef.current.scrollTop = top; }); });
    };
    restore(); window.addEventListener('resize', restore);
    const timer = setTimeout(() => { window.removeEventListener('resize', restore); presentationScroll.current = null; }, 1000);
    return () => { clearTimeout(timer); cancelAnimationFrame(frame); window.removeEventListener('resize', restore); };
  }, [presenting]);

  return <div className="app-shell" onDragOver={(event) => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  }} onDrop={(event) => {
    if (installLockRef.current) { event.preventDefault(); return; }
    if (event.defaultPrevented) return;
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) => /\.(pdf|docx|png|jpe?g|webp)$/i.test(item.name));
    if (file) void openPath(window.aster.pathForFile(file));
    else setError('Drop a PDF, DOCX, or image file to open it.');
  }}>
    <header className="topbar">
      <button className="brand brand-home" type="button" onClick={() => void goHome()} disabled={busy || commentSaving || returningHome || preparingInstall || installing} aria-label="Home — Recently opened PDFs" title="Home · Recently opened PDFs"><img src="./icon.png" alt="" /><span>Aster<span className="brand-pdf">PDF</span></span></button>
      <div className="topbar-divider" />
      <div className="document-title" title={source?.path}>{source ? <><FileText size={17} /><strong>{source.name}</strong>{busy || commentSaving ? <span className="saving-spinner" role="status" aria-label={commentSaving ? 'Saving comments in the background' : compressionProgress || 'Working'} title={commentSaving ? 'Saving comments in the background' : compressionProgress || 'Working'} /> : (pendingCommentCount > 0 || editingDirty || source.needsSave) && <span className="unsaved-dot" title="Unsaved changes" />}</> : <span>No document open</span>}</div>
      <div className="topbar-actions">
        <button className="button subtle" onClick={() => setSettingsOpen(true)} title="Application settings"><Settings2 size={18} /><span>Settings</span></button>
        {(updates.state?.available || updates.state?.transfer.phase === 'ready') && <button className="button update-button" aria-label="Update AsterPDF" title="View update progress and installation"
          onClick={() => { setSettingsOpen(true); if (!updates.downloading && updates.state?.transfer.phase !== 'ready') void updates.download(); }}>
          {updates.downloading ? <span className="inline-spinner" /> : <ArrowDownToLine size={17} />}<span>{updates.downloading ? `Downloading ${Math.floor(updates.state?.transfer.percent || 0)}%` : updates.state?.transfer.phase === 'ready' ? 'Restart and install…' : 'Update'}</span></button>}
        <button className="button subtle" onClick={() => void openSelected()} disabled={busy}><FolderOpen size={18} /><span>Open file</span></button>
        <button className="button primary" onClick={() => void save()} disabled={!source || (!pendingCommentCount && !editingDirty && !source.needsSave) || busy || commentSaving}><Save size={17} /><span>{busy ? 'Working…' : 'Save PDF'}</span></button>
      </div>
    </header>

    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} aria-hidden="true" /></button></div>}

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
        <div className={`viewer-toolbar${activeTool === 'edit' || activeTool === 'draw' ? ' has-edit-tools' : ''}`}>
          {pageGridOpen ? <div className="grid-toolbar-heading"><button className="button outline" onClick={() => closePageGrid()} aria-label="Return to PDF view"><ChevronLeft size={16} />PDF view</button><span>{effectivePages.length} {effectivePages.length === 1 ? 'page' : 'pages'}</span></div> : <>
            <div className="toolbar-group page-control"><button className="icon-button" onClick={() => scrollToPage(Math.max(1, pageNumber - 1))} disabled={pageNumber <= 1} aria-label="Previous page"><ChevronLeft size={18} /></button><span><strong>{pageNumber}</strong><i>/</i>{document ? effectivePages.length : '…'}</span><button className="icon-button" onClick={() => scrollToPage(Math.min(effectivePages.length, pageNumber + 1))} disabled={pageNumber >= effectivePages.length} aria-label="Next page"><ChevronRight size={18} /></button></div>
            <div className="toolbar-group zoom-control"><button className="icon-button" onClick={() => adjustZoom(-1)} aria-label="Zoom out"><Minus size={17} /></button><button className="zoom-label" onClick={() => changeZoom('fit')}>{zoomValue}</button><button className="icon-button" onClick={() => adjustZoom(1)} aria-label="Zoom in"><Plus size={17} /></button></div>
          </>}
          {activeTool !== 'edit' && activeTool !== 'draw' && <div className="toolbar-spacer" />}
          {placedSignatures.length > 0 ? <div className="signature-review" role="group" aria-label="Pending signatures">
            <span className="signature-review-label" role="status">{placedSignatures.length} {placedSignatures.length === 1 ? 'signature' : 'signatures'} pending · confirm to comment</span>
            <button className="button signature-confirm-action" onClick={() => void save()} disabled={busy} title="Confirm and save signatures" aria-label="Confirm and save signatures"><Check size={18} /><span>Confirm</span></button>
            <button className="button signature-discard-action" onClick={() => setPendingSignatureDiscard(true)} disabled={busy} title="Discard pending signatures" aria-label="Discard pending signatures"><X size={18} /><span>Discard</span></button>
          </div> : activeTool === 'comments' ? <div className="comment-tools" role="group" aria-label="Comment and text markup tools">
            <button className={`icon-button${!markupTool && !placing ? ' active' : ''}`} title="Select text or comments" aria-label="Select text or comments" aria-pressed={!markupTool && !placing}
              onClick={() => { setMarkupTool(null); setPlacing(false); }}><MousePointer2 size={18} /></button>
            <button className={`icon-button${placing ? ' active' : ''}`} onClick={startComment} disabled={!document || busy || editingDirty}
              title={placing ? 'Click on page to add a comment' : 'Add comment'} aria-label="Add comment" aria-pressed={placing}><MessageSquare size={18} /></button>
            {(['Highlight', 'Strikeout', 'Underline'] as const).map(kind => <button key={kind} className={`icon-button markup-tool${markupTool === kind ? ' active' : ''}`}
              style={{ '--markup-color': markupColors[kind] } as React.CSSProperties} onMouseDown={event => event.preventDefault()}
              onClick={() => chooseMarkupTool(kind)} disabled={!document || busy || editingDirty || Boolean(pagePlan)} aria-pressed={markupTool === kind}
              aria-label={kind === 'Highlight' ? 'Highlight text' : kind === 'Strikeout' ? 'Mark text for removal' : 'Mark text for replacement'}
              title={kind === 'Highlight' ? 'Highlight text' : kind === 'Strikeout' ? 'Removal — strikethrough' : 'Replacement — underline'}>
              {kind === 'Highlight' ? <Highlighter size={18} /> : kind === 'Strikeout' ? <Strikethrough size={18} /> : <Underline size={18} />}
            </button>)}
            <span className="comment-tool-hint">{markupTool ? 'Drag across text' : placing ? 'Click on page…' : 'Select text to mark up'}</span>
          </div>
          : activeTool === 'edit' || activeTool === 'draw' ? null
          : activeTool === 'pages' ? <div className="page-tools toolbar-page-tools" aria-label="Selected page actions">
            <button title="Undo edit" aria-label="Undo edit" disabled={busy || pendingCommentCount > 0 || !historyPast.length} onClick={undoEdit}><Undo2 size={16} /></button>
            <button title="Redo edit" aria-label="Redo edit" disabled={busy || pendingCommentCount > 0 || !historyFuture.length} onClick={redoEdit}><Redo2 size={16} /></button>
            <button title="Move page up" aria-label="Move page up" disabled={busy || pendingCommentCount > 0 || selectedIndices.every((index) => index === 0)} onClick={() => applySelection('move-up')}><ArrowUp size={16} /></button>
            <button title="Move page down" aria-label="Move page down" disabled={busy || pendingCommentCount > 0 || selectedIndices.every((index) => index === effectivePages.length - 1)} onClick={() => applySelection('move-down')}><ArrowDown size={16} /></button>
            <button title="Rotate left" aria-label="Rotate left" disabled={busy || pendingCommentCount > 0} onClick={() => applySelection('rotate-left')}><RotateCcw size={16} /></button>
            <button title="Rotate right" aria-label="Rotate right" disabled={busy || pendingCommentCount > 0} onClick={() => applySelection('rotate-right')}><RotateCw size={16} /></button>
            <button title="Duplicate page" aria-label="Duplicate page" disabled={busy || pendingCommentCount > 0} onClick={() => applySelection('duplicate')}><Copy size={16} /></button>
            <button title="Delete page" aria-label="Delete page" disabled={busy || pendingCommentCount > 0 || selectedIndices.length >= effectivePages.length} onClick={() => applySelection('delete')}><Trash2 size={16} /></button>
          </div> : activeTool === 'sign' ? <div className="signature-picker"><button className={`button ${placingSignatureId ? 'placing-button' : 'outline'} tool-action context-action`} onClick={startSignature} disabled={!document || busy || pendingCommentCount > 0} aria-expanded={signatureMenuOpen} aria-haspopup="menu"><PenLine size={16} />{placingSignatureId ? 'Place signature…' : 'Sign'}</button>
            {signatureMenuOpen && <div className="signature-dropdown" role="menu" aria-label="Saved signatures">
              {savedSignatures.length ? savedSignatures.map((signature) => <div className="signature-option" key={signature.id}>
                <button role="menuitem" onClick={() => chooseSignature(signature.id)}><img src={signature.dataUrl} alt="" /><span>{signature.name}</span></button>
                <button className="signature-option-delete" title={`Remove ${signature.name}`} aria-label={`Remove ${signature.name}`} onClick={() => { setSignatureMenuOpen(false); setPendingSignatureRemoval({ kind: 'saved', id: signature.id, name: signature.name }); }}><X size={14} /></button>
              </div>) : <p className="signature-empty">No saved signatures yet</p>}
              <button className="signature-add" role="menuitem" onClick={openNewSignature}>+ Signature</button>
            </div>}
          </div> : activeTool === 'compress' ? <button className="button outline tool-action context-action" onClick={() => { setCompressionError(''); setCompressionOpen(true); }} disabled={!document || busy || pendingCommentCount > 0}><Shrink size={16} />Compress</button>
          : <button className="button outline tool-action context-action" onClick={() => void addFiles()} disabled={!document || busy || pendingCommentCount > 0}><Files size={16} />Add files</button>}
        {(activeTool === 'edit' || activeTool === 'draw') && <div className="overlay-toolbar" role="toolbar" aria-label={activeTool === 'edit' ? 'Edit tools' : 'Draw tools'}>
          <button className={overlayTool === 'select' && !selectingLinks ? 'active' : ''} onClick={() => { setSelectingLinks(false); setOverlayTool('select'); }} aria-label="Select objects" aria-pressed={overlayTool === 'select' && !selectingLinks} title="Select and move objects (V)"><MousePointer2 size={17} /></button>
          {activeTool === 'edit' ? <>
            <button className={selectingLinks ? 'active' : ''} aria-label="Select PDF text" aria-pressed={selectingLinks} title="Select text for copying or adding a hyperlink"
              disabled={busy || pendingCommentCount > 0 || Boolean(pagePlan)} onClick={() => {
                if (selectingLinks) setSelectingLinks(false); else void startHyperlink([]);
              }}><TextSelect size={17} /></button>
            <button aria-label="Add hyperlink" title="Add hyperlink to selected text" data-added-text-controls
              disabled={busy || pendingCommentCount > 0 || Boolean(pagePlan)} onMouseDown={event => event.preventDefault()}
              onClick={() => void startHyperlink()}><Link2 size={17} /></button>
            <button className={overlayTool === 'text' ? 'active' : ''} onClick={() => { setSelectingLinks(false); setOverlayTool('text'); }} aria-label="Add text overlay" title="Add editable text over the PDF"><Type size={17} /></button>
            <FontPicker selection={textFontSelection} fonts={installedFonts} loading={fontsStatus === 'loading'} onSelect={(choice) => {
              if (selectedText && fontEditing?.overlayId !== selectedText.id) {
                const updated = { ...selectedText, fontChoice: choice as OverlayObject['fontChoice'] };
                const size = displayPageSize(effectivePages.findIndex((item) => item.id === updated.pageId) + 1);
                setOverlayFontChoice(updated.fontChoice);
                updateOverlay({ ...updated, ...textOverlaySize(updated, size.width, size.height, installedFonts) });
                return;
              }
              if (!fontEditing) { setOverlayFontChoice(choice as OverlayObject['fontChoice']); return; }
              setFontEditing({ ...fontEditing, choice });
              if (fontEditing.overlayId) setOverlayFontChoice(choice as OverlayObject['fontChoice']);
              setFontCommand((old) => ({ pageId: fontEditing.pageId, index: fontEditing.index, overlayId: fontEditing.overlayId, choice, sequence: (old?.sequence || 0) + 1 }));
            }} />
            <div className="text-format-tools" role="group" aria-label="Text formatting" data-added-text-controls>
              <button disabled={!canFormatText} aria-label="Bold" title="Bold" aria-pressed={activeTextFont.fontWeight >= 600} onClick={() => changeTextAppearance({ bold: activeTextFont.fontWeight < 600 })}><Bold size={16} /></button>
              <button disabled={!canFormatText} aria-label="Italic" title="Italic" aria-pressed={activeTextFont.fontStyle === 'italic'} onClick={() => changeTextAppearance({ italic: activeTextFont.fontStyle !== 'italic' })}><Italic size={16} /></button>
              <button disabled={!canFormatText} aria-label="Underline" title="Underline" aria-pressed={Boolean(activeTextAppearance.underline)} onClick={() => changeTextAppearance({ underline: !activeTextAppearance.underline })}><Underline size={16} /></button>
              <button disabled={!canFormatText} aria-label="Strikethrough" title="Strikethrough" aria-pressed={Boolean(activeTextAppearance.strikeThrough)} onClick={() => changeTextAppearance({ strikeThrough: !activeTextAppearance.strikeThrough })}><Strikethrough size={16} /></button>
            </div>
            <div className="text-format-tools" role="group" aria-label="Text alignment" data-added-text-controls>
              {([{ align: 'left', Icon: AlignLeft }, { align: 'center', Icon: AlignCenter }, { align: 'right', Icon: AlignRight }, { align: 'justify', Icon: AlignJustify }] as const).map(({ align, Icon }) =>
                <button key={align} disabled={!canFormatText} aria-label={`Align text ${align}`} title={`Align ${align} within text box`} aria-pressed={(activeTextAppearance.textAlign || 'left') === align}
                  onClick={() => changeTextAppearance({ textAlign: align })}><Icon size={16} /></button>)}
              <button disabled={!canFormatText} aria-label="Smart justify" title="Smart Justify · Arabic Kashida on wrapped lines"
                aria-pressed={activeTextAppearance.textAlign === 'smart-justify'} onClick={() => changeTextAppearance({ textAlign: 'smart-justify' })}><SmartJustifyIcon /></button>
              <button disabled={!canFormatText} aria-label="Auto-size text container" title="Auto-size text container · Drag its handles for a fixed size"
                aria-pressed={activeTextAppearance.textSizing !== 'fixed'} onClick={() => changeTextAppearance({ textSizing: 'auto' })}><Maximize2 size={16} /></button>
            </div>
            <button className={overlayTool === 'image' ? 'active' : ''} onClick={() => overlayImageRef.current?.click()} aria-label="Add image overlay"
              title={overlayTool === 'image' ? 'Click on a page to place the image. Esc to cancel.' : 'Add an image'}><ImagePlus size={17} /></button>
            <span className="overlay-divider" />
            <button onClick={undoEdit} disabled={!historyPast.length} aria-label="Undo edit"><Undo2 size={17} /></button>
            <button onClick={redoEdit} disabled={!historyFuture.length} aria-label="Redo edit"><Redo2 size={17} /></button>
          </> : <>
            <button className={overlayTool === 'rectangle' ? 'active' : ''} onClick={() => chooseDrawingTool('rectangle')} aria-pressed={overlayTool === 'rectangle'} aria-label="Draw rectangle" title="Rectangle (R) · Click or drag"><Square size={17} /></button>
            <button className={overlayTool === 'ellipse' ? 'active' : ''} onClick={() => chooseDrawingTool('ellipse')} aria-pressed={overlayTool === 'ellipse'} aria-label="Draw ellipse" title="Ellipse (O) · Shift for a circle"><Circle size={17} /></button>
            <button className={overlayTool === 'line' ? 'active' : ''} onClick={() => chooseDrawingTool('line')} aria-pressed={overlayTool === 'line'} aria-label="Draw line" title="Line (L) · Shift snaps the angle"><Minus size={17} /></button>
            <button className={overlayTool === 'pen' ? 'active' : ''} onClick={() => chooseDrawingTool('pen')} aria-pressed={overlayTool === 'pen'} aria-label="Freehand pen" title="Freehand pen (P)"><Pencil size={17} /></button>
            <button className={overlayTool === 'image' ? 'active' : ''} onClick={() => overlayImageRef.current?.click()} aria-label="Add image overlay" title="Place an image"><ImagePlus size={17} /></button>
            <button className={overlayTool === 'eraser' ? 'active' : ''} onClick={() => chooseDrawingTool('eraser')} aria-pressed={overlayTool === 'eraser'} aria-label="Erase object" title="Erase object (E)"><Eraser size={17} /></button>
            <span className="overlay-divider" />
            <button onClick={undoEdit} disabled={!historyPast.length} aria-label="Undo drawing" title="Undo (Ctrl/Cmd+Z)"><Undo2 size={17} /></button>
            <button onClick={redoEdit} disabled={!historyFuture.length} aria-label="Redo drawing" title="Redo (Ctrl/Cmd+Shift+Z)"><Redo2 size={17} /></button>
          </>}
          <span className="overlay-divider" />
          <ColorPicker value={activeTool === 'draw' ? currentDrawStyle.color : (!fontEditing && selectedOverlay?.color) || overlayColor}
            recent={recentColors} onChange={activeTool === 'draw' ? (color, commit) => changeDrawStyle({ color }, commit) : chooseOverlayColor} />
          {activeTool === 'edit' ? <div className="overlay-font-size" data-added-text-controls>
            <NumberField label="Font size" icon={<Type size={15} />} unit="pt" min={4} max={500} value={overlayFontSize}
              onChange={(value) => changeOverlayFontSize(value)} onPreview={(value) => changeOverlayFontSize(value, false)} /></div>
            : <button className={sidebarTab === 'draw' && !sidebarCollapsed ? 'active' : ''} title="Properties and layers" aria-label="Toggle drawing panel"
              aria-expanded={sidebarTab === 'draw' && !sidebarCollapsed} onClick={() => { setSidebarTab('draw'); setSidebarCollapsed(sidebarTab === 'draw' ? !sidebarCollapsed : false); }}><PanelRight size={17} /></button>}
          {selectedOverlay && <button disabled={selectedOverlay.locked} onClick={() => deleteOverlay(selectedOverlay.id)} title="Delete selected object" aria-label="Delete selected object"><Trash2 size={17} /></button>}
          <input ref={overlayImageRef} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(event) => { void importOverlayImage(event.target.files?.[0]); event.target.value = ''; }} />
        </div>}
        </div>
        {pageGridOpen ? <div className="page-grid-scroll">
          <div className="page-grid-intro"><div><h2>Organize pages</h2><p>Drag a page to reorder it. Select pages to use the actions above.</p></div><span>{selectedPages.size ? `${selectedPages.size} selected` : `${effectivePages.length} pages`}</span></div>
          <div className="page-grid" aria-label="Pages grid">{effectivePages.map((planned, index) => <article key={planned.id} className={`page-grid-card${selectedPages.has(index) ? ' selected' : ''}${gridDragOver === index ? ' drag-target' : ''}`} draggable={!busy && !pendingCommentCount}
            onDragStart={(event) => { dragPageRef.current = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); }}
            onDragOver={(event) => { if (dragPageRef.current !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setGridDragOver(index); } }}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const from = dragPageRef.current; dragPageRef.current = null; setGridDragOver(null); if (from !== null && from !== index) void applyEdit({ type: 'move', from, to: index }); }}
            onDragEnd={() => { dragPageRef.current = null; setGridDragOver(null); }}>
            <div className="page-grid-card-head"><label><input type="checkbox" aria-label={`Select page ${index + 1}`} checked={selectedPages.has(index)} onChange={() => setSelectedPages((previous) => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; })} /><strong>Page {index + 1}</strong></label><GripVertical size={18} aria-hidden="true" /></div>
            <button className="page-grid-preview" aria-label={`Select page ${index + 1} preview`} aria-pressed={selectedPages.has(index)} onClick={() => setSelectedPages((previous) => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; })}>{document && <PageThumbnail document={document} page={planned.sourceIndex + 1} rotation={planned.turns * 90} size="large" />}</button>
            <div className="page-grid-card-foot"><span>{pagePlan ? `Original page ${planned.sourceIndex + 1}` : 'Drag to reorder'}</span><button onClick={() => closePageGrid(index + 1)} aria-label={`View page ${index + 1} in PDF`}>View page <ChevronRight size={14} /></button></div>
          </article>)}</div>
        </div> : <div className="viewer-scroll" ref={viewerRef}>
          <div className="page-wrap">
            {!document && <div className="loading-page">Opening PDF…</div>}
            {document && effectivePages.map((planned, index) => {
              const page = index + 1;
              return <PdfPage key={planned.id} document={document} pageNumber={page} sourcePageNumber={planned.sourceIndex + 1} rotation={planned.turns * 90}
                onRenderSettled={pageRendered}
                getSourceBytes={getSourceBytes} inspectOriginalText={!selectingLinks && !pendingCommentCount && activeTool === 'edit' && overlayTool === 'select' && (fontsStatus === 'ready' || fontsStatus === 'error')} onCommitOriginalText={commitOriginalText} onMoveOriginalText={moveOriginalText}
                onFontEditChange={changeFontEditing} fontCommand={fontCommand} colorCommand={colorCommand} installedFonts={installedFonts}
                size={displayPageSize(page)}
                zoom={zoom} viewerWidth={viewerWidth} viewerRef={viewerRef}
                comments={showCommentPins ? commentsByPage.get(page) ?? EMPTY_COMMENTS : EMPTY_COMMENTS} selectedId={selectedId}
                placing={placing} pendingPoint={pendingPoint} pageId={planned.id}
                signatures={placedSignatures.filter((signature) => signature.pageId === planned.id)} selectedSignatureId={selectedSignatureId} placingSignature={activeSignature}
                overlayTool={!selectingLinks && !pendingCommentCount && (activeTool === 'edit' || activeTool === 'draw') ? overlayTool : null}
                drawActive={activeTool === 'draw'}
                textAppearance={textAppearance}
                overlayColor={activeTool === 'draw' ? drawDefaults.color : overlayColor} overlayLineWidth={activeTool === 'draw' ? drawDefaults.lineWidth : overlayLineWidth} drawStyle={drawDefaults} overlayFontSize={overlayFontSize} overlayFontChoice={overlayFontChoice} overlayImage={overlayImage}
                overlays={visibleOverlays.filter((object) => object.pageId === planned.id)} selectedOverlayId={selectedOverlayId}
                onAddOverlay={addOverlay} onUpdateOverlay={updateOverlay} onDeleteOverlay={deleteOverlay}
                onSelectOverlay={selectOverlay}
                registerPage={registerPage} onMeasure={measurePage} onPlace={choosePoint}
                onAddSignature={addSignatureAt} onUpdateSignature={updateSignature} onSelectSignature={setSelectedSignatureId} onDeleteSignature={requestSignatureRemoval}
                popupCommentId={popupCommentId}
                commentsActive={activeTool === 'comments'} markingText={Boolean(markupTool)} onCommentColor={changeMarkupColor} recentColors={recentColors}
                editActive={activeTool === 'edit'} selectingLinks={activeTool === 'edit' && selectingLinks}
                onLinkMenu={(x, y, selection) => { if (!busy && !pendingCommentCount && !pagePlan) setLinkMenu({ x, y, selection }); }}
                onNavigateLink={sourcePage => {
                  const index = effectivePages.findIndex(page => page.sourceIndex === sourcePage - 1);
                  if (index >= 0) scrollToPage(index + 1);
                }}
                onAddMarkupComment={(comment) => {
                  setPopupCommentId(null); setSelectedId(comment.id); selectTool('comments');
                  setMarkupTool(null); setEditingComment({ comment, text: comment.text, bold: comment.bold }); setPendingCommentScroll(comment.id);
                }}
                onDeleteMarkup={(comment) => changeComment(comment, 'delete')}
                onReplyComment={startReply}
                commentEditingDisabled={busy || returningHome || editingDirty || placedSignatures.length > 0 || Boolean(pagePlan)}
                onSelectComment={(id) => { setSelectedId(id); setPopupCommentId(id); }}
                onCloseComment={() => { setSelectedId(null); setPopupCommentId(null); }}
                onOpenCommentSidebar={(id) => { setPopupCommentId(null); setSelectedId(id); selectTool('comments'); setPendingCommentScroll(id); }}
                onError={reportPageError} />;
            })}
          </div>
        </div>}
        <div className="viewer-footer"><button className="icon-button presentation-button" aria-label="Start presentation" title="Present full screen · Arrow keys to navigate · Esc to exit" disabled={!document || busy || preparingInstall || installing} onClick={() => void startPresentation()}><Presentation size={17} /></button><span className="footer-document-path">{compressionProgress || source.path}</span><span>{document ? effectivePages.length : '…'} pages · Offline</span></div>
      </section>

      <ResizableSidebar collapsed={sidebarCollapsed}>
        {!sidebarCollapsed && <div className="sidebar-content">
        {sidebarTab === 'draw' ? (() => {
          const index = drawSelection ? effectivePages.findIndex((item) => item.id === drawSelection.pageId) : pageNumber - 1;
          const page = Math.max(0, index) + 1, size = displayPageSize(page);
          return <DrawInspector objects={overlays.filter((item) => item.pageId === effectivePages[page - 1]?.id && item.kind !== 'text')}
            selected={drawSelection} page={page} pageWidth={size.width} pageHeight={size.height} style={currentDrawStyle} recent={recentColors} busy={busy}
            onStyle={changeDrawStyle} onUpdate={updateOverlay} onSelect={(id) => { selectOverlay(id); setOverlayTool('select'); }}
            onDelete={deleteOverlay} onDuplicate={duplicateOverlay} onOrder={orderOverlay} onClose={() => setSidebarCollapsed(true)} />;
        })() : sidebarTab === 'comments' ? <>
          <div className="sidebar-heading"><h2 className="comments-heading">Comments <span>{conversationComments.length}</span></h2><div className="comment-heading-actions">
            <button className="icon-button" title={showCommentPins ? 'Hide comments on pages' : 'Show comments on pages'} aria-label={showCommentPins ? 'Hide comments on pages' : 'Show comments on pages'} aria-pressed={showCommentPins} onClick={() => setShowCommentPins((visible) => !visible)}>{showCommentPins ? <Eye size={19} /> : <EyeOff size={19} />}</button>
            <button className="icon-button" title="Save a copy" aria-label="Save a copy" disabled={busy || commentSaving} onClick={() => void save(true)}><FilePlus2 size={19} /></button>
          </div></div>
          <div className="comment-list" ref={commentListRef}>
            {listedComments.length === 0 && !pendingPoint ? <div className="empty-comments"><div><MessageSquare size={25} /></div><h3>Start a conversation</h3><p>{placedSignatures.length ? 'Confirm and save the pending signature above to add a comment.' : 'Comments in this PDF will appear here. Click “Add comment” and choose a spot on the page.'}</p>{!placedSignatures.length && <button className="text-button" onClick={startComment}>Add the first comment <ChevronRight size={15} /></button>}</div> : null}
            {listedComments.map(thread => <section key={thread.id}
              className={`comment-card comment-thread${selectedId === thread.id || thread.replies?.some(reply => reply.id === selectedId) ? ' selected' : ''}`}
              aria-label={`Comment thread by ${thread.author}`}>
              {renderCommentEntry(thread, thread)}
              {!!thread.replies?.length && <div className="comment-thread-replies" aria-label="Replies">
                {thread.replies.map(reply => renderCommentEntry(reply, thread))}
              </div>}
            </section>)}
          </div>
          {pendingPoint && <div className="compose"><div className="compose-title"><span className="avatar">{authorName.charAt(0).toUpperCase()}</span><strong>{pendingPoint.replyTo ? 'Reply' : 'New comment'}</strong><button onClick={() => { setPendingPoint(null); setNoteText(''); setNoteBold([]); }} aria-label={pendingPoint.replyTo ? 'Cancel reply' : 'Cancel comment'}><X size={17} /></button></div>
            {pendingPoint.replyTo && <div className="reply-context">Replying to {allComments.find(comment => comment.id === pendingPoint.replyTo)?.author ?? 'comment'}</div>}
            <CommentEditor key={pendingPoint.replyTo ?? 'new'} label={pendingPoint.replyTo ? 'Write a reply' : 'Write a comment'} placeholder={pendingPoint.replyTo ? 'Write your reply…' : 'Write your comment…'} value={noteText} bold={noteBold} onChange={(text, bold) => { setNoteText(text); setNoteBold(bold); }}
              onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addComment(); } }} />
            <div className="compose-footer"><span>Page {pendingPoint.page} · {authorName}</span><button className="button primary" onClick={addComment} disabled={!noteText.trim() || busy || returningHome || editingDirty || placedSignatures.length > 0 || Boolean(pagePlan)}>{pendingPoint.replyTo ? 'Reply' : 'Add comment'}</button></div></div>}
          <div className="sidebar-bottom"><CircleHelp size={16} /><span>Comments are saved inside the PDF.</span></div>
        </> : <div className="pages-panel"><div className="sidebar-heading"><div><h2>Pages</h2><p>{selectedPages.size ? `${selectedPages.size} selected` : 'Drag pages to sort, or use the arrows.'}</p></div><button className="icon-button" onClick={openPageGrid} aria-label="Expand pages to grid" title="Expand pages to grid"><Maximize2 size={18} /></button></div>
          <div className="page-selection"><button onClick={() => setSelectedPages(new Set(Array.from({ length: effectivePages.length }, (_, index) => index)))}>Select all</button><button onClick={() => setSelectedPages(new Set())} disabled={!selectedPages.size}>Clear</button></div>
          <div className="page-list">{effectivePages.map((planned, index) => <div key={planned.id} draggable={!busy && !pendingCommentCount} className={`page-row ${pageNumber === index + 1 ? 'active' : ''}`}
            onDragStart={(event) => { dragPageRef.current = index; event.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(event) => { if (dragPageRef.current !== null) { event.preventDefault(); event.stopPropagation(); } }}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const from = dragPageRef.current; dragPageRef.current = null; if (from !== null && from !== index) void applyEdit({ type: 'move', from, to: index }); }}
            onDragEnd={() => { dragPageRef.current = null; }}>
            <input type="checkbox" aria-label={`Select page ${index + 1}`} checked={selectedPages.has(index)} onChange={() => setSelectedPages((previous) => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; })} />
            <button onClick={() => scrollToPage(index + 1)}>{document && <PageThumbnail document={document} page={planned.sourceIndex + 1} rotation={planned.turns * 90} />}<span className="page-row-label"><strong>Page {index + 1}</strong>{pagePlan && <em>Original page {planned.sourceIndex + 1}</em>}</span><small className="page-comment-count">{commentsByPage.get(index + 1)?.length || ''}</small></button>
            <button className="page-insert" aria-label={`Add files after page ${index + 1}`} title="Add files after this page" disabled={busy || pendingCommentCount > 0} onClick={() => void addFiles(index)}><FilePlus2 size={15} /></button>
          </div>)}</div>
          <div className="sidebar-bottom"><Files size={16} /><button className="text-button" onClick={() => void addFiles()} disabled={busy || pendingCommentCount > 0}>Add PDF, Word, or images</button></div>
        </div>}
        </div>}
        <div className="sidebar-rail" role="toolbar" aria-label="PDF tools" aria-orientation="vertical">
          <button className="sidebar-toggle" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!sidebarCollapsed}>{sidebarCollapsed ? <ChevronLeft size={19} /> : <ChevronRight size={19} />}</button>
          <button className={activeTool === 'comments' ? 'active' : ''} onClick={() => selectTool('comments')} aria-label="Comments" title="Comments" aria-pressed={activeTool === 'comments'}><MessageSquare size={18} />{conversationComments.length > 0 && <span className="sidebar-rail-count">{conversationComments.length}</span>}</button>
          <button className={activeTool === 'pages' ? 'active' : ''} onClick={() => selectTool('pages')} aria-label="Pages" title="Pages" aria-pressed={activeTool === 'pages'}><FileText size={18} /></button>
          <button className={activeTool === 'edit' ? 'active' : ''} onClick={() => selectTool('edit')} aria-label="Edit" title="Edit" aria-pressed={activeTool === 'edit'}><Pencil size={18} /></button>
          <button className={activeTool === 'draw' ? 'active' : ''} onClick={() => selectTool('draw')} aria-label="Draw" title="Draw" aria-pressed={activeTool === 'draw'}><Paintbrush size={18} /></button>
          <span className="sidebar-rail-divider" aria-hidden="true" />
          <button className={activeTool === 'sign' ? 'active' : ''} onClick={() => selectTool('sign')} aria-label="Sign tool" title="Sign" aria-pressed={activeTool === 'sign'}><PenLine size={18} /></button>
          <button className={activeTool === 'compress' ? 'active' : ''} onClick={() => selectTool('compress')} disabled={placedSignatures.length > 0} aria-label="Compress tool" title={placedSignatures.length ? 'Confirm signatures first' : 'Compress'} aria-pressed={activeTool === 'compress'}><Shrink size={18} /></button>
          <button className={activeTool === 'files' ? 'active' : ''} onClick={() => selectTool('files')} disabled={placedSignatures.length > 0} aria-label="Add files tool" title={placedSignatures.length ? 'Confirm signatures first' : 'Add files'} aria-pressed={activeTool === 'files'}><Files size={18} /></button>
        </div>
      </ResizableSidebar>
    </main>}
    {linkMenu && <HyperlinkMenu {...linkMenu} onClose={() => setLinkMenu(null)}
      onAdd={() => void startHyperlink(linkMenu.selection)} onSelectText={() => void startHyperlink([])} />}
    {linkSelection && <HyperlinkDialog selection={linkSelection} onSave={applyHyperlink} onClose={() => setLinkSelection(null)} />}

    {compressionOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) setCompressionOpen(false); }}><div className="settings-modal feature-modal" role="dialog" aria-modal="true" aria-labelledby="compression-title"><div className="modal-head"><div className="modal-icon"><Shrink size={21} /></div><button onClick={() => setCompressionOpen(false)} disabled={busy} aria-label="Close compression"><X size={19} /></button></div><h2 id="compression-title">Compress PDF</h2><p>Select a preset, then save a compressed copy. Compression starts after you choose where to save it.</p>
      <div className="compression-estimate-status" role="status">{visibleCompressionEstimate.status === 'ready'
        ? `Current PDF: ${formatFileSize(visibleCompressionEstimate.originalSize)} · Estimates based on ${visibleCompressionEstimate.sampledPages} sample ${visibleCompressionEstimate.sampledPages === 1 ? 'page' : 'pages'}.`
        : visibleCompressionEstimate.status === 'calculating' ? <><span className="inline-spinner" />{visibleCompressionEstimate.progress}</>
        : visibleCompressionEstimate.status === 'error' ? `Size estimates unavailable: ${visibleCompressionEstimate.message}. You can still choose a preset.` : 'Preparing size estimates…'}</div>
      <div className="compression-options" role="group" aria-label="Compression preset">{COMPRESSION_PRESETS.map((preset) => <button key={preset.level} className={compressionChoice === preset.level ? 'selected' : ''} aria-pressed={compressionChoice === preset.level} disabled={busy}
        onClick={() => { setCompressionChoice(preset.level); setCompressionError(''); }}><span className="compression-option-heading"><strong>{preset.label}</strong><b>{visibleCompressionEstimate.status === 'ready' ? `≈ ${formatFileSize(visibleCompressionEstimate.sizes[preset.level])}` : 'Estimate pending'}</b></span><span>{preset.description}</span></button>)}</div>
      <p className="compression-warning">Balanced and Smallest flatten pages into images. Searchable text, links, form fields, and comments will no longer be interactive in the saved copy. The original PDF stays in place.</p>
      {compressionError && <p className="compression-error" role="alert">{compressionError}</p>}
      {busy && compressionProgress && <p className="compression-running" role="status"><span className="inline-spinner" />{compressionProgress}</p>}
      <div className="modal-actions"><button className="button subtle" disabled={busy} onClick={() => setCompressionOpen(false)}>Cancel</button><button className="button primary" disabled={!compressionChoice || busy} onClick={() => void saveCompressedCopy()}><Save size={16} />Save compressed copy…</button></div>
    </div></div>}
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
    {pendingSignatureDiscard && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingSignatureDiscard(false); }}><div className="settings-modal confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="discard-signatures-title" aria-describedby="discard-signatures-description">
      <h2 id="discard-signatures-title">Discard pending signatures?</h2>
      <p id="discard-signatures-description">Remove {placedSignatures.length} {placedSignatures.length === 1 ? 'signature' : 'signatures'} placed since the last save? Your saved signature list stays on this computer.</p>
      <div className="modal-actions"><button className="button subtle" autoFocus onClick={() => setPendingSignatureDiscard(false)}>Keep signatures</button><button className="button danger" onClick={discardPendingSignatures}>Discard signatures</button></div>
    </div></div>}
    {aboutOpen && <AboutDialog updates={updates} busy={busy || preparingInstall || installing} onClose={() => setAboutOpen(false)} />}
    {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
      <div className="settings-modal application-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-head"><div className="modal-icon"><Settings2 size={21} /></div><button onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={19} /></button></div>
        <h2 id="settings-title">Settings</h2>
        <h3>Comment author</h3><p>This name appears on comments you add to PDF files. It is saved only on this computer.</p>
        <label htmlFor="author-name">Your name</label><input id="author-name" autoFocus value={authorInput} onChange={(event) => setAuthorInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void saveSettings(); }} placeholder="Enter your name" maxLength={80} />
        <UpdateSettings updates={updates} onInstall={() => void restartAndInstall()} busy={busy || preparingInstall || installing} installError={installError} />
        <div className="modal-actions"><button className="button subtle" onClick={() => setSettingsOpen(false)}>Close</button>
          <button className="button primary" onClick={() => void saveSettings()} disabled={!authorInput.trim()}>Save settings</button></div>
      </div>
    </div>}
    {(preparingInstall || installing) && <div className="modal-backdrop update-install-backdrop"><div className="settings-modal" role="alertdialog" aria-modal="true" aria-labelledby="install-title">
      <h2 id="install-title">{preparingInstall ? 'Saving before restart…' : 'Restarting to install…'}</h2>
      <p role="status"><span className="inline-spinner" /> {preparingInstall ? 'Please wait while your PDF changes are saved.' : 'Your changes are saved. AsterPDF will reopen after the update.'}</p>
    </div></div>}
    {wordExportResult && <div className="word-export-notice" role="status">
      <div><strong>Saved {wordExportResult.name}</strong>
        <p>{wordExportResult.pages} source pages · {wordExportResult.tables} editable tables.
          {' '}{wordExportResult.kind === 'data' ? 'Review extraction notes before using the figures.' : 'Review the converted layout before use.'}</p>
        {wordExportResult.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      </div>
      <button className="icon-button" aria-label="Dismiss Word export result" onClick={() => setWordExportResult(null)}><X size={17} /></button>
    </div>}
    <SaveFeedback message={discardRequestId ? null : openingMessage || (saveMessage ? (wordExporting ? saveMessage : compressionProgress || saveMessage) : null)}
      title={openingMessage ? 'Opening your PDF' : wordExporting === 'data' ? 'Extracting PDF data' : wordExporting ? 'Converting to Word' : 'Saving your PDF'} />
    {discardRequestId && <div className="modal-backdrop discard-backdrop"><div className="settings-modal discard-modal" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-description">
      <div className="discard-icon"><TriangleAlert size={23} /></div>
      <h2 id="discard-title">Discard unsaved changes?</h2>
      <p id="discard-description">Your changes to this PDF have not been saved. Save them before leaving this document if you want to keep them.</p>
      <div className="discard-actions"><button className="button confirm-keep" autoFocus onClick={() => answerDiscard(false)}><Check size={17} />Keep editing</button><button className="button danger" onClick={() => answerDiscard(true)}><Trash2 size={16} />Discard changes</button></div>
    </div></div>}
    {presenting && document && <PresentationView pdf={document} pages={effectivePages} initialPage={pageNumber}
      objects={visibleOverlays} signatures={placedSignatures} fonts={installedFonts} onExit={exitPresentation} />}
  </div>;
}

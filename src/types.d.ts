export {};

declare global {
  interface Window {
    aster: {
      openDialog(): Promise<OpenedFile | null>;
      addDialog(): Promise<OpenedFile[] | null>;
      openPath(path: string): Promise<OpenedFile | null>;
      pathForFile(file: File): string;
      save(bytes: Uint8Array, saveAs: boolean, expectedPath: string): Promise<{ path: string; name: string } | null>;
      listOriginalText(bytes: Uint8Array, pageIndex: number): Promise<OriginalPdfText[]>;
      listInstalledFonts(): Promise<{ id: string; family: string; style: string; postscriptName: string }[]>;
      readInstalledFont(id: string, text: string): Promise<Uint8Array>;
      replaceOriginalText(bytes: Uint8Array, pageIndex: number, objectIndex: number, expectedText: string, replacement: string, fontChoice?: string, color?: number[]): Promise<Uint8Array>;
      moveOriginalText(bytes: Uint8Array, pageIndex: number, objectIndex: number, expectedText: string, dx: number, dy: number): Promise<Uint8Array>;
      embedShapedText(bytes: Uint8Array, placements: { pageIndex: number; text: string; size: number; matrix: number[]; color: number[]; fontChoice?: string }[]): Promise<Uint8Array>;
      prepareCompressedSave(expectedPath: string): Promise<{ token: string; path: string } | null>;
      finishCompressedSave(bytes: Uint8Array, token: string, expectedPath: string): Promise<{ path: string; name: string }>;
      discardCompressedSave(token: string): Promise<void>;
      printDocx(): Promise<Uint8Array>;
      getRecentPdfs(): Promise<RecentPdf[]>;
      setRecentPreview(path: string, preview: string): Promise<void>;
      getSettings(): Promise<{ authorName: string }>;
      getUpdateStatus(): Promise<UpdateStatus>;
      checkForUpdates(): Promise<UpdateStatus>;
      downloadUpdate(): Promise<UpdateStatus>;
      installUpdate(): Promise<void>;
      onUpdateStatus(handler: (state: UpdateStatus) => void): () => void;
      setAuthorName(name: string): Promise<{ authorName: string }>;
      setDirty(value: boolean): void;
      setSaving(value: boolean): void;
      onDiscardRequest(handler: (id: string) => void): () => void;
      answerDiscardRequest(id: string, discard: boolean): void;
      onMenu(channel: 'menu:open' | 'menu:save' | 'menu:save-as' | 'menu:settings' | 'menu:undo' | 'menu:redo', handler: () => void): () => void;
    };
  }
}

export interface OpenedPdf {
  name: string;
  path: string;
  bytes: Uint8Array;
  needsSave?: boolean;
}

export interface UpdateStatus {
  transfer: {
    phase: 'idle' | 'preparing' | 'downloading' | 'ready' | 'installing' | 'error';
    version: string | null;
    percent: number;
    transferred: number;
    total: number;
    error: string | null;
  };
  status: 'idle' | 'checking' | 'current' | 'available' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  downloadAvailable: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}

export interface OriginalPdfText {
  index: number;
  text: string;
  box: number[];
  fontName: string;
  matrix: number[];
  fontSize: number;
  color: number[];
}

export interface OpenedFile extends OpenedPdf {
  kind: 'pdf' | 'docx' | 'png' | 'jpg' | 'jpeg' | 'webp';
}

export interface RecentPdf {
  path: string;
  name: string;
  openedAt: number;
  preview: string | null;
}

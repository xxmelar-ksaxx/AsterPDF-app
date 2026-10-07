export {};

declare global {
  interface Window {
    aster: {
      openDialog(): Promise<OpenedFile | null>;
      addDialog(): Promise<OpenedFile[] | null>;
      openPath(path: string): Promise<OpenedFile | null>;
      pathForFile(file: File): string;
      save(bytes: Uint8Array, saveAs: boolean, expectedPath: string): Promise<{ path: string; name: string } | null>;
      printDocx(): Promise<Uint8Array>;
      getRecentPdfs(): Promise<RecentPdf[]>;
      setRecentPreview(path: string, preview: string): Promise<void>;
      getSettings(): Promise<{ authorName: string }>;
      setAuthorName(name: string): Promise<{ authorName: string }>;
      setDirty(value: boolean): void;
      setSaving(value: boolean): void;
      onMenu(channel: 'menu:open' | 'menu:save' | 'menu:save-as' | 'menu:settings', handler: () => void): () => void;
    };
  }
}

export interface OpenedPdf {
  name: string;
  path: string;
  bytes: Uint8Array;
  needsSave?: boolean;
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

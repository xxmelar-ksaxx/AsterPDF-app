export {};

declare global {
  interface Window {
    aster: {
      openDialog(): Promise<OpenedFile | null>;
      addDialog(): Promise<OpenedFile[] | null>;
      openPath(path: string): Promise<OpenedFile | null>;
      pathForFile(file: File): string;
      save(bytes: Uint8Array, saveAs: boolean, expectedPath: string): Promise<{ path: string; name: string } | null>;
      prepareCompressedSave(expectedPath: string): Promise<{ token: string; path: string } | null>;
      finishCompressedSave(bytes: Uint8Array, token: string, expectedPath: string): Promise<{ path: string; name: string }>;
      discardCompressedSave(token: string): Promise<void>;
      printDocx(): Promise<Uint8Array>;
      getRecentPdfs(): Promise<RecentPdf[]>;
      setRecentPreview(path: string, preview: string): Promise<void>;
      getSettings(): Promise<{ authorName: string }>;
      setAuthorName(name: string): Promise<{ authorName: string }>;
      setDirty(value: boolean): void;
      setSaving(value: boolean): void;
      onDiscardRequest(handler: (id: string) => void): () => void;
      answerDiscardRequest(id: string, discard: boolean): void;
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

import type { FileFormat, FileData, ConvertPathNode } from "./FormatHandler.js";
import type { TraversionGraph } from "./TraversionGraph.js";

declare global {
  // File System Access API types (Chromium-only)
  interface FileSystemFileHandle {
    readonly kind: "file";
    readonly name: string;
    getFile(): Promise<File>;
    createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
  }

  interface FileSystemDirectoryHandle {
    readonly kind: "directory";
    readonly name: string;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
    values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  }

  interface FileSystemWritableFileStream extends WritableStream {
    write(data: BufferSource | Blob | string | ArrayBufferView | ArrayBuffer): Promise<void>;
    close(): Promise<void>;
  }

  interface Window {
    supportedFormatCache: Map<string, FileFormat[]>;
    traversionGraph: TraversionGraph;
    printSupportedFormatCache: () => string;
    showPopup: (html: string) => void;
    hidePopup: () => void;
    tryConvertByTraversing: (files: FileData[], from: ConvertPathNode, to: ConvertPathNode) => Promise<{
      files: FileData[];
      path: ConvertPathNode[];
    } | null>;
    showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}

export { };

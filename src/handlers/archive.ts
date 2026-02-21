import { gzip } from "pako";
import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

/**
 * Builds a POSIX ustar TAR archive from an array of FileData entries.
 */
function createTar(files: FileData[]): Uint8Array {
  const BLOCK = 512;
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();

  const writeField = (buf: Uint8Array, value: string, offset: number, size: number) => {
    const bytes = enc.encode(value.slice(0, size));
    buf.set(bytes, offset);
  };

  for (const file of files) {
    const header = new Uint8Array(BLOCK);

    writeField(header, file.name, 0, 100);                                                   // name
    writeField(header, "0000644\0", 100, 8);                                                 // mode
    writeField(header, "0000000\0", 108, 8);                                                 // uid
    writeField(header, "0000000\0", 116, 8);                                                 // gid
    writeField(header, file.bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12);    // size
    writeField(header, Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12); // mtime
    header.fill(0x20, 148, 156);                                                             // checksum placeholder (spaces)
    header[156] = 0x30;                                                                      // type '0' = regular file
    writeField(header, "ustar", 257, 6);                                                     // magic
    writeField(header, "00", 263, 2);                                                        // version

    // Compute checksum over the header with spaces in the checksum field
    let checksum = 0;
    for (let i = 0; i < BLOCK; i++) checksum += header[i];
    writeField(header, checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);

    blocks.push(header);

    // File data padded to 512-byte boundary
    const padded = Math.ceil(file.bytes.length / BLOCK) * BLOCK;
    const data = new Uint8Array(padded);
    data.set(file.bytes);
    blocks.push(data);
  }

  // Two end-of-archive null blocks
  blocks.push(new Uint8Array(BLOCK * 2));

  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) { out.set(b, offset); offset += b.length; }
  return out;
}

class ArchiveHandler implements FormatHandler {
  public name = "archive";
  public supportAnyInput = true;
  public ready = false;

  public supportedFormats: FileFormat[] = [
    CommonFormats.TAR.builder("tar").allowTo().markLossless(),
    CommonFormats.TGZ.builder("tgz").allowTo().markLossless(),
    CommonFormats.GZ.builder("gz").allowTo().markLossless(),
    CommonFormats.SEVEN_Z.builder("7z").allowTo().markLossless(),
  ];

  private sevenZip: any = null;

  async init() {
    const SevenZip = (await import("7z-wasm")).default;
    this.sevenZip = await SevenZip({
      locateFile: (path: string) => `/wasm/${path}`,
    });
    this.ready = true;
  }

  async doConvert(
    files: FileData[],
    _input: FileFormat,
    output: FileFormat
  ): Promise<FileData[]> {

    if (output.internal === "tar") {
      return [{ name: "archive.tar", bytes: createTar(files) }];
    }

    if (output.internal === "tgz") {
      return [{ name: "archive.tar.gz", bytes: gzip(createTar(files)) }];
    }

    if (output.internal === "gz") {
      // Compress each file individually to its own .gz
      return files.map(f => ({
        name: f.name + ".gz",
        bytes: gzip(f.bytes),
      }));
    }

    if (output.internal === "7z") {
      const sz = this.sevenZip;
      const names = files.map(f => f.name);

      for (const file of files) {
        sz.FS.writeFile(file.name, file.bytes);
      }
      sz.callMain(["a", "-t7z", "archive.7z", ...names]);
      const result: Uint8Array = sz.FS.readFile("archive.7z");

      // Clean up virtual FS
      for (const name of names) {
        try { sz.FS.unlink(name); } catch (_) {}
      }
      try { sz.FS.unlink("archive.7z"); } catch (_) {}

      return [{ name: "archive.7z", bytes: result }];
    }

    throw new Error(`Unsupported output format: ${output.format}`);
  }
}

export default ArchiveHandler;

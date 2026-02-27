import type { FileData } from "./FormatHandler.ts";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { LogEvent } from "@ffmpeg/ffmpeg";
import { compressVideoWebCodecs, compressVideoVP9, isWebCodecsAvailable } from "./webcodecs-compress.ts";

/** Yield to the browser so pending DOM updates get painted */
const yieldToBrowser = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// ── Lazy FFmpeg instances ──

let compressFFmpeg: FFmpeg | null = null;
let ffmpegReady: Promise<void> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (!compressFFmpeg) compressFFmpeg = new FFmpeg();
  if (!ffmpegReady) ffmpegReady = compressFFmpeg.load({ coreURL: "/wasm/ffmpeg-core.js" }).then(() => {});
  await ffmpegReady;
  return compressFFmpeg;
}

async function reloadFFmpeg(): Promise<FFmpeg> {
  if (compressFFmpeg) compressFFmpeg.terminate();
  compressFFmpeg = new FFmpeg();
  ffmpegReady = compressFFmpeg.load({ coreURL: "/wasm/ffmpeg-core.js" }).then(() => {});
  await ffmpegReady;
  return compressFFmpeg;
}

async function ffExec(args: string[], timeout = -1): Promise<void> {
  const ff = await getFFmpeg();
  const checkExit = (code: number | void) => {
    if (typeof code === "number" && code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
  };
  try {
    if (timeout === -1) {
      checkExit(await ff.exec(args));
    } else {
      checkExit(await Promise.race([
        ff.exec(args, timeout),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FFmpeg timeout")), timeout)),
      ]));
    }
  } catch (e) {
    if (typeof e === "string" && e.includes("out of bounds")) {
      await reloadFFmpeg();
      const ff2 = await getFFmpeg();
      checkExit(await ff2.exec(args));
    } else {
      throw e;
    }
  }
}

async function ffExecWithLog(args: string[]): Promise<string> {
  const ff = await getFFmpeg();
  let log = "";
  const handler = (e: LogEvent) => { log += e.message + "\n"; };
  ff.on("log", handler);
  try {
    await ffExec(args);
  } catch {
    // We still want the log even on error (e.g. probing with -f null)
  }
  ff.off("log", handler);
  return log;
}

/** Run FFmpeg with progress bar updates via the "progress" event */
async function ffExecWithProgress(args: string[], _totalDuration: number, _label: string, timeout = -1): Promise<void> {
  const ff = await getFFmpeg();

  // Track whether encoding progress has moved beyond 0% (for stall detection)
  let progressMoved = false;

  // Use the "progress" event which provides { progress: 0..1, time: microseconds }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onProgress = (e: any) => {
    if ((e.progress ?? 0) > 0) progressMoved = true;
    const pct = Math.min(Math.round((e.progress ?? 0) * 100), 99);
    const bar = document.getElementById("compress-progress-bar");
    const pctEl = document.getElementById("compress-progress-pct");
    if (bar) bar.style.width = pct + "%";
    if (pctEl) pctEl.textContent = pct + "%";
  };

  // Also parse time= from log as fallback (some ffmpeg.wasm versions)
  const onLog = (e: LogEvent) => {
    const match = e.message.match(/time=\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (match) {
      const current = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 100;
      if (current > 0) progressMoved = true;
      if (_totalDuration > 0) {
        const pct = Math.min(Math.round((current / _totalDuration) * 100), 99);
        const bar = document.getElementById("compress-progress-bar");
        const pctEl = document.getElementById("compress-progress-pct");
        if (bar) bar.style.width = pct + "%";
        if (pctEl) pctEl.textContent = pct + "%";
      }
    }
  };

  ff.on("progress", onProgress);
  ff.on("log", onLog);
  try {
    if (timeout > 0) {
      // Stall detection: if progress hasn't moved from 0% within the timeout, abort.
      // Once progress moves, the stall check disarms and encoding runs freely.
      // Shows a visible countdown so the user knows when fallback will happen.
      const stallSeconds = Math.round(timeout / 1000);
      let stallTimer: ReturnType<typeof setTimeout>;
      const stallPromise = new Promise<void>((resolve, reject) => {
        let elapsed = 0;
        const check = setInterval(() => {
          if (progressMoved) {
            clearInterval(check); clearTimeout(stallTimer);
            const fallbackEl = document.getElementById("compress-fallback-timer");
            if (fallbackEl) fallbackEl.remove();
            resolve();
            return;
          }
          elapsed++;
          const remaining = stallSeconds - elapsed;
          const fallbackEl = document.getElementById("compress-fallback-timer");
          if (fallbackEl) fallbackEl.textContent = `Falling back to H.264 in ${remaining}s if no progress...`;
        }, 1000);
        // Insert countdown element into the popup
        const pctEl = document.getElementById("compress-progress-pct");
        if (pctEl) {
          const timer = document.createElement("p");
          timer.id = "compress-fallback-timer";
          timer.style.cssText = "text-align:center;color:var(--text-muted);font-size:0.8rem;margin-top:4px";
          timer.textContent = `Falling back to H.264 in ${stallSeconds}s if no progress...`;
          pctEl.insertAdjacentElement("afterend", timer);
        }
        stallTimer = setTimeout(() => {
          clearInterval(check);
          if (!progressMoved) reject(new Error("FFmpeg stall timeout"));
          else resolve();
        }, timeout);
      });
      await Promise.race([ffExec(args), stallPromise]);
    } else {
      await ffExec(args);
    }
  } finally {
    ff.off("progress", onProgress);
    ff.off("log", onLog);
  }
}

// ── Lazy ImageMagick init ──

let magickReady: Promise<void> | null = null;

async function ensureMagick(): Promise<void> {
  if (!magickReady) {
    magickReady = (async () => {
      const { initializeImageMagick } = await import("@imagemagick/magick-wasm");
      const wasmResponse = await fetch("/wasm/magick.wasm");
      const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
      await initializeImageMagick(wasmBytes);
    })();
  }
  await magickReady;
}

// ── File type detection ──

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "tif", "avif", "ico", "heif", "heic"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "avi", "mov", "mkv", "flv", "wmv", "ogv", "m4v", "3gp", "ts", "mts"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "flac", "aac", "wma", "m4a", "opus", "oga", "weba"]);

function getExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function getMediaType(name: string): "image" | "video" | "audio" | "unknown" {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "unknown";
}

// ── Duration parsing ──

function parseDuration(ffmpegLog: string): number {
  const match = ffmpegLog.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) return 0;
  return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 100;
}

// ── Image compression ──

async function compressImage(file: FileData, targetBytes: number, mode: "auto" | "lossy"): Promise<FileData> {
  await ensureMagick();
  const { ImageMagick, MagickFormat } = await import("@imagemagick/magick-wasm");

  const ext = getExt(file.name);
  const baseName = file.name.replace(/\.[^.]+$/, "");
  const losslessFormats = new Set(["png", "bmp", "tiff", "tif"]);
  const qualityFormats = new Set(["jpg", "jpeg", "webp", "avif", "heif", "heic"]);

  const extToFmt: Record<string, typeof MagickFormat[keyof typeof MagickFormat]> = {
    png: MagickFormat.Png, jpg: MagickFormat.Jpeg, jpeg: MagickFormat.Jpeg,
    webp: MagickFormat.WebP, gif: MagickFormat.Gif, bmp: MagickFormat.Bmp,
    tiff: MagickFormat.Tiff, tif: MagickFormat.Tiff, ico: MagickFormat.Ico,
    avif: MagickFormat.Avif,
  };

  const updateProgress = async (step: number, total: number) => {
    const pct = Math.round((step / total) * 100);
    const bar = document.getElementById("compress-progress-bar");
    const pctEl = document.getElementById("compress-progress-pct");
    if (bar) bar.style.width = pct + "%";
    if (pctEl) pctEl.textContent = pct + "%";
    await yieldToBrowser();
  };

  // Helper: encode image at given quality
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const encodeAt = (quality: number, fmt: any, resize?: { w: number; h: number }): Uint8Array => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ImageMagick.read(file.bytes as any, (img: any) => {
      img.strip();
      if (resize) img.resize(resize.w, resize.h);
      img.quality = quality;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return img.write(fmt, (out: any) => new Uint8Array(out));
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getDims = (): { w: number; h: number } => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ImageMagick.read(file.bytes as any, (img: any) => ({
      w: img.width as number, h: img.height as number,
    }));
  };

  // Lossless attempt (auto mode): strip metadata and re-export
  if (mode === "auto") {
    const fmt = extToFmt[ext] ?? MagickFormat.Png;
    try {
      const optimized = encodeAt(100, fmt);
      if (optimized && optimized.length <= targetBytes) {
        return { name: file.name, bytes: optimized };
      }
    } catch { /* fall through */ }
  }

  // Lossy: binary search on quality for formats that support it
  if (qualityFormats.has(ext)) {
    const fmt = extToFmt[ext]!;
    let lo = 5, hi = 95;
    let bestBytes: Uint8Array = file.bytes;
    let found = false;

    for (let i = 0; i < 8; i++) {
      await updateProgress(i + 1, 8);
      const mid = Math.round((lo + hi) / 2);
      try {
        const result = encodeAt(mid, fmt);
        if (result.length <= targetBytes) {
          bestBytes = result;
          found = true;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      } catch { break; }
    }

    if (found) return { name: file.name, bytes: bestBytes };

    // Quality alone wasn't enough — resize + quality
    const dims = getDims();
    return await resizeToFit(file, targetBytes, ext, fmt, dims, encodeAt, updateProgress);
  }

  // Lossless format (PNG/BMP/TIFF) that's still too big → convert to WebP lossy
  if (losslessFormats.has(ext)) {
    let lo = 5, hi = 95;
    let bestBytes: Uint8Array | null = null;

    for (let i = 0; i < 8; i++) {
      await updateProgress(i + 1, 8);
      const mid = Math.round((lo + hi) / 2);
      try {
        const result = encodeAt(mid, MagickFormat.WebP);
        if (result.length <= targetBytes) {
          bestBytes = result;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      } catch { break; }
    }

    if (bestBytes) return { name: baseName + ".webp", bytes: bestBytes };

    // Resize too
    const dims = getDims();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resized = await resizeToFit(file, targetBytes, "webp", MagickFormat.WebP, dims, encodeAt);
    return { name: baseName + ".webp", bytes: resized.bytes };
  }

  // GIF: reduce via FFmpeg
  if (ext === "gif") {
    return compressGif(file, targetBytes);
  }

  return file;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resizeToFit(
  file: FileData, targetBytes: number, outExt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outFmt: any, dims: { w: number; h: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encodeAt: (quality: number, fmt: any, resize?: { w: number; h: number }) => Uint8Array,
  progressFn?: (step: number, total: number) => Promise<void> | void
): Promise<FileData> {
  const baseName = file.name.replace(/\.[^.]+$/, "");
  let lo = 0.1, hi = 1.0;
  let bestBytes: Uint8Array = file.bytes;
  let found = false;

  for (let i = 0; i < 6; i++) {
    if (progressFn) await progressFn(i + 1, 6);
    const scale = (lo + hi) / 2;
    const w = Math.round(dims.w * scale);
    const h = Math.round(dims.h * scale);

    try {
      const result = encodeAt(70, outFmt, { w, h });
      if (result.length <= targetBytes) {
        bestBytes = result;
        found = true;
        lo = scale;
      } else {
        hi = scale;
      }
    } catch { break; }
  }

  if (!found) {
    console.warn(`Could not compress "${file.name}" to target size.`);
  }

  return { name: baseName + "." + outExt, bytes: bestBytes };
}

async function compressGif(file: FileData, targetBytes: number): Promise<FileData> {
  const ff = await getFFmpeg();
  const inputName = "compress_input.gif";
  const outputName = "compress_output.gif";

  await ff.writeFile(inputName, new Uint8Array(file.bytes));

  const scales = [1, 0.75, 0.5, 0.35];
  const fpsOptions = [15, 10, 8];

  const totalAttempts = fpsOptions.length * scales.length;
  let attempt = 0;

  for (const fps of fpsOptions) {
    for (const scale of scales) {
      attempt++;
      const pct = Math.min(Math.round((attempt / totalAttempts) * 100), 99);
      const bar = document.getElementById("compress-progress-bar");
      const pctEl = document.getElementById("compress-progress-pct");
      if (bar) bar.style.width = pct + "%";
      if (pctEl) pctEl.textContent = pct + "%";

      const vf = scale < 1
        ? `fps=${fps},scale=iw*${scale}:ih*${scale}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse`
        : `fps=${fps},split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse`;

      try {
        await ffExec(["-hide_banner", "-y", "-i", inputName, "-vf", vf, outputName]);
        const data = await ff.readFile(outputName);
        const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data as string);

        if (bytes.length <= targetBytes) {
          await ff.deleteFile(inputName).catch(() => {});
          await ff.deleteFile(outputName).catch(() => {});
          return { name: file.name, bytes };
        }
      } catch { /* try next */ }
    }
  }

  // Return best effort
  try {
    const data = await ff.readFile(outputName);
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data as string);
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});
    console.warn(`Could not compress GIF "${file.name}" to target size.`);
    return { name: file.name, bytes };
  } catch {
    await ff.deleteFile(inputName).catch(() => {});
    return file;
  }
}

// ── Video compression ──

async function compressVideo(
  file: FileData,
  targetBytes: number,
  encoderSpeed: "fast" | "balanced" | "quality" = "balanced",
  crf?: number,
  codec: "h264" | "h265" = "h264"
): Promise<FileData> {
  // ── WebCodecs fast path (hardware-accelerated) ──
  if (isWebCodecsAvailable()) {
    const result = await compressVideoWebCodecs(file, targetBytes, encoderSpeed, crf, codec);
    if (result !== null) return result;
    console.info(`WebCodecs unavailable for "${file.name}", falling back to ffmpeg.wasm`);
    await showCompressPopup(
      `<h2>Falling back to software encoding...</h2>` +
      `<p>${file.name}</p>` +
      `<p style="color:var(--text-muted);font-size:0.85rem">WebCodecs couldn't hit target size. Using ffmpeg for tighter control.</p>` +
      `<div style="background:var(--input-border);border-radius:8px;height:18px;margin:12px 0;overflow:hidden">` +
        `<div id="compress-progress-bar" style="background:var(--accent);height:100%;width:0%;transition:width 0.3s;border-radius:8px"></div>` +
      `</div>` +
      `<p id="compress-progress-pct" style="text-align:center;color:var(--text-muted);font-size:0.85rem">0%</p>`
    );
  }

  // ── ffmpeg.wasm fallback ──
  {
  const ff = await getFFmpeg();
  const ext = getExt(file.name);
  const inputName = "compress_input." + ext;
  const outputName = "compress_output." + ext;
  const isWebM = ext === "webm";

  // Codec selection
  const videoCodec = isWebM ? "libvpx-vp9" : (codec === "h265" ? "libx265" : "libx264");
  const audioCodec = isWebM ? "libopus" : "aac";
  // libx265 in ffmpeg.wasm only supports 10-bit pixel format
  const pixFmtArgs: string[] = (!isWebM && codec === "h265") ? ["-pix_fmt", "yuv420p10le"] : [];
  // Stall detection: if progress stays at 0% for 15s, codec likely unsupported in this WASM build
  const stallTimeout = (codec === "h265" && !isWebM) ? 15000 : -1;

  await ff.writeFile(inputName, new Uint8Array(file.bytes));

  // Probe duration and audio presence
  const probeLog = await ffExecWithLog(["-hide_banner", "-i", inputName, "-f", "null", "-"]);
  const duration = parseDuration(probeLog);
  const hasAudio = probeLog.includes("Audio:");

  // Encoder speed arguments
  const speedArgs: string[] = isWebM
    ? (encoderSpeed === "fast" ? ["-deadline", "realtime"]
       : encoderSpeed === "quality" ? ["-deadline", "good", "-cpu-used", "0"]
       : ["-deadline", "good", "-cpu-used", "2"])
    : ["-preset", encoderSpeed === "fast" ? "ultrafast" : encoderSpeed === "quality" ? "medium" : "fast"];

  // ── Quality / re-encode mode (CRF only, no target size) ──
  if (targetBytes === 0 && crf !== undefined) {
    const crfArgs: string[] = isWebM
      ? ["-crf", String(crf), "-b:v", "0"]
      : ["-crf", String(crf)];

    const args = [
      "-hide_banner", "-y", "-i", inputName,
      "-c:v", videoCodec, ...pixFmtArgs, ...speedArgs, ...crfArgs,
      ...(hasAudio ? ["-c:a", "copy"] : ["-an"]),
      outputName,
    ];

    try {
      await ffExecWithProgress(args, duration > 0 ? duration : 0, "Re-encoding video...", stallTimeout);
    } catch (e) {
      // If H.265 failed or stalled, reload FFmpeg and fall back to H.264
      if (codec === "h265" && !isWebM) {
        console.warn(`H.265 encoding failed for "${file.name}", falling back to H.264:`, e);
        await showCompressPopup(
          `<h2>H.265 failed, falling back to H.264...</h2>` +
          `<p>${file.name}</p>` +
          `<p style="color:var(--text-muted);font-size:0.85rem">H.265 is not supported in this browser build. Re-encoding with H.264 instead.</p>` +
          `<div style="background:var(--input-border);border-radius:8px;height:18px;margin:12px 0;overflow:hidden">` +
            `<div id="compress-progress-bar" style="background:var(--accent);height:100%;width:0%;transition:width 0.3s;border-radius:8px"></div>` +
          `</div>` +
          `<p id="compress-progress-pct" style="text-align:center;color:var(--text-muted);font-size:0.85rem">0%</p>`
        );
        await reloadFFmpeg();
        return compressVideo(file, targetBytes, encoderSpeed, crf, "h264");
      }
      await ff.deleteFile(inputName).catch(() => {});
      console.warn(`Video re-encode failed for "${file.name}":`, e);
      return file;
    }

    const data = await ff.readFile(outputName);
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data as string);
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});

    // If re-encode is larger than original, keep original
    if (bytes.length >= file.bytes.length) {
      console.warn(`Re-encode of "${file.name}" is larger than original (${(bytes.length / 1024 / 1024).toFixed(1)} MB vs ${(file.bytes.length / 1024 / 1024).toFixed(1)} MB), keeping original.`);
      return file;
    }
    return { name: file.name, bytes };
  }

  // ── Target size mode ──
  if (duration <= 0) {
    await ff.deleteFile(inputName).catch(() => {});
    console.warn(`Could not determine duration for "${file.name}", skipping compression.`);
    return file;
  }

  // Calculate target bitrate (3% safety margin for container overhead)
  const safeTarget = targetBytes * 0.97;
  const audioBits = hasAudio ? 96000 : 0;
  const totalBitrate = (safeTarget * 8) / duration;
  const videoBitrate = Math.max(Math.floor(totalBitrate - audioBits), 50000);

  const audioArgs = hasAudio
    ? ["-c:a", audioCodec, "-b:a", "96k"]
    : ["-an"];

  // Single-pass ABR: direct bitrate targeting for tight size control
  try {
    await ffExecWithProgress([
      "-hide_banner", "-y", "-i", inputName,
      "-c:v", videoCodec, ...pixFmtArgs, ...speedArgs,
      "-b:v", String(videoBitrate),
      ...audioArgs,
      outputName,
    ], duration, "Compressing video...", stallTimeout);
  } catch (e) {
    // If H.265 failed or stalled, reload FFmpeg and fall back to H.264
    if (codec === "h265" && !isWebM) {
      console.warn(`H.265 compression failed for "${file.name}", falling back to H.264:`, e);
      await showCompressPopup(
        `<h2>H.265 failed, falling back to H.264...</h2>` +
        `<p>${file.name}</p>` +
        `<p style="color:var(--text-muted);font-size:0.85rem">H.265 is not supported in this browser build. Compressing with H.264 instead.</p>` +
        `<div style="background:var(--input-border);border-radius:8px;height:18px;margin:12px 0;overflow:hidden">` +
          `<div id="compress-progress-bar" style="background:var(--accent);height:100%;width:0%;transition:width 0.3s;border-radius:8px"></div>` +
        `</div>` +
        `<p id="compress-progress-pct" style="text-align:center;color:var(--text-muted);font-size:0.85rem">0%</p>`
      );
      await reloadFFmpeg();
      return compressVideo(file, targetBytes, encoderSpeed, crf, "h264");
    }
    await ff.deleteFile(inputName).catch(() => {});
    console.warn(`Video compression failed for "${file.name}":`, e);
    return file;
  }

  const data = await ff.readFile(outputName);
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data as string);

  await ff.deleteFile(inputName).catch(() => {});
  await ff.deleteFile(outputName).catch(() => {});

  // If re-encode is larger than original, keep original
  if (bytes.length >= file.bytes.length) {
    console.warn(`Re-encode of "${file.name}" is larger than original, keeping original.`);
    return file;
  }

  if (bytes.length > targetBytes) {
    // ffmpeg couldn't hit target — try VP9 as last resort (changes format to WebM)
    if (targetBytes > 0 && isWebCodecsAvailable()) {
      await showCompressPopup(
        `<h2>Trying VP9 codec (last resort)...</h2>` +
        `<p>${file.name}</p>` +
        `<p style="color:var(--text-muted);font-size:0.85rem">Original codec couldn't hit target. Trying VP9 — output will be WebM.</p>` +
        `<div style="background:var(--input-border);border-radius:8px;height:18px;margin:12px 0;overflow:hidden">` +
          `<div id="compress-progress-bar" style="background:var(--accent);height:100%;width:0%;transition:width 0.3s;border-radius:8px"></div>` +
        `</div>` +
        `<p id="compress-progress-pct" style="text-align:center;color:var(--text-muted);font-size:0.85rem">0%</p>`
      );
      const vp9Result = await compressVideoVP9(file, targetBytes);
      if (vp9Result) return vp9Result;
    }
    console.warn(`Could not compress "${file.name}" to target size. Best: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
  }

  return { name: file.name, bytes };
  }
}

// ── Audio compression ──

async function compressAudio(file: FileData, targetBytes: number, mode: "auto" | "lossy"): Promise<FileData> {
  const ff = await getFFmpeg();
  const ext = getExt(file.name);
  const inputName = "compress_input." + ext;
  const baseName = file.name.replace(/\.[^.]+$/, "");

  await ff.writeFile(inputName, new Uint8Array(file.bytes));

  // Lossless: WAV → FLAC
  if (mode === "auto" && ext === "wav") {
    const flacName = "compress_output.flac";
    try {
      await ffExec(["-hide_banner", "-y", "-i", inputName, "-c:a", "flac", flacName]);
      const data = await ff.readFile(flacName);
      const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data as string);
      await ff.deleteFile(flacName).catch(() => {});

      if (bytes.length <= targetBytes) {
        await ff.deleteFile(inputName).catch(() => {});
        return { name: baseName + ".flac", bytes };
      }
    } catch { /* fall through to lossy */ }
  }

  // Get duration
  const probeLog = await ffExecWithLog(["-hide_banner", "-i", inputName, "-f", "null", "-"]);
  const duration = parseDuration(probeLog);

  if (duration <= 0) {
    await ff.deleteFile(inputName).catch(() => {});
    console.warn(`Could not determine duration for "${file.name}", skipping compression.`);
    return file;
  }

  // Calculate target bitrate
  const targetBitrate = Math.floor((targetBytes * 0.95 * 8) / duration);
  const bitrate = Math.max(32000, Math.min(targetBitrate, 320000));

  let codec: string, outExt: string;
  if (ext === "ogg" || ext === "oga") {
    codec = "libvorbis"; outExt = "ogg";
  } else if (ext === "opus" || ext === "weba") {
    codec = "libvorbis"; outExt = "ogg";
  } else if (ext === "flac" || ext === "wav") {
    codec = "libmp3lame"; outExt = "mp3";
  } else if (ext === "aac" || ext === "m4a") {
    codec = "aac"; outExt = ext;
  } else {
    codec = "libmp3lame"; outExt = "mp3";
  }

  const outputName = "compress_output." + outExt;

  try {
    await ffExecWithProgress([
      "-hide_banner", "-y", "-i", inputName,
      "-c:a", codec, "-b:a", String(Math.floor(bitrate / 1000)) + "k",
      outputName,
    ], duration, "Compressing audio...");
  } catch (e) {
    await ff.deleteFile(inputName).catch(() => {});
    console.warn(`Audio compression failed for "${file.name}":`, e);
    return file;
  }

  const data = await ff.readFile(outputName);
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data as string);

  await ff.deleteFile(inputName).catch(() => {});
  await ff.deleteFile(outputName).catch(() => {});

  if (bytes.length > targetBytes) {
    console.warn(`Could not compress "${file.name}" to target size. Best: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
  }

  return { name: baseName + "." + outExt, bytes };
}

// ── Main entry point ──

async function showCompressPopup(html: string) {
  const popup = document.getElementById("popup");
  if (popup) popup.innerHTML = html;
  await yieldToBrowser();
}

export async function applyFileCompression(
  files: FileData[],
  targetBytes: number,
  mode: "auto" | "lossy",
  encoderSpeed: "fast" | "balanced" | "quality" = "balanced",
  crf?: number,
  codec: "h264" | "h265" = "h264"
): Promise<FileData[]> {
  const isReencode = targetBytes === 0 && crf !== undefined;
  const result: FileData[] = [];

  // Re-encode mode: only process video files. Target mode: only files above target.
  const toProcess = isReencode
    ? files.filter(f => getMediaType(f.name) === "video")
    : files.filter(f => f.bytes.length > targetBytes);

  const targetMB = isReencode ? null : (targetBytes / 1024 / 1024).toFixed(1);

  for (const f of files) {
    if (!toProcess.includes(f)) {
      result.push(f);
      continue;
    }

    const idx = toProcess.indexOf(f) + 1;
    const type = getMediaType(f.name);
    const sizeMB = (f.bytes.length / 1024 / 1024).toFixed(1);

    const heading = isReencode
      ? `<h2>Re-encoding video...</h2><p>${f.name} (${sizeMB} MB)</p>`
      : `<h2>Compressing ${type}...</h2><p>${f.name} (${sizeMB} MB → ${targetMB} MB)</p>`;

    await showCompressPopup(
      heading +
      (toProcess.length > 1 ? `<p style="color:var(--text-muted);font-size:0.85rem">File ${idx} of ${toProcess.length}</p>` : "") +
      `<div style="background:var(--input-border);border-radius:8px;height:18px;margin:12px 0;overflow:hidden">` +
        `<div id="compress-progress-bar" style="background:var(--accent);height:100%;width:0%;transition:width 0.3s;border-radius:8px"></div>` +
      `</div>` +
      `<p id="compress-progress-pct" style="text-align:center;color:var(--text-muted);font-size:0.85rem">0%</p>`
    );

    switch (type) {
      case "image":
        if (!isReencode) result.push(await compressImage(f, targetBytes, mode));
        else result.push(f);
        break;
      case "video":
        result.push(await compressVideo(f, targetBytes, encoderSpeed, crf, codec));
        break;
      case "audio":
        if (!isReencode) result.push(await compressAudio(f, targetBytes, mode));
        else result.push(f);
        break;
      default:
        result.push(f);
        break;
    }
  }

  return result;
}

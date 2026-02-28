import type { FileData } from "./FormatHandler.ts";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { LogEvent } from "@ffmpeg/ffmpeg";
import {
  Input, Output, Conversion, BufferSource as MBBufferSource, BufferTarget,
  Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat,
  ALL_FORMATS, canEncodeAudio,
} from "mediabunny";

// ── Own FFmpeg instance (separate from compress module) ──

let vidFFmpeg: FFmpeg | null = null;
let vidFFmpegReady: Promise<void> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (!vidFFmpeg) vidFFmpeg = new FFmpeg();
  if (!vidFFmpegReady) vidFFmpegReady = vidFFmpeg.load({ coreURL: "/wasm/ffmpeg-core.js" }).then(() => {});
  await vidFFmpegReady;
  return vidFFmpeg;
}

async function reloadFFmpeg(): Promise<FFmpeg> {
  if (vidFFmpeg) vidFFmpeg.terminate();
  vidFFmpeg = new FFmpeg();
  vidFFmpegReady = vidFFmpeg.load({ coreURL: "/wasm/ffmpeg-core.js" }).then(() => {});
  await vidFFmpegReady;
  return vidFFmpeg;
}

async function ffExec(args: string[]): Promise<void> {
  const ff = await getFFmpeg();
  const code = await ff.exec(args);
  if (typeof code === "number" && code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
}

async function ffExecWithLog(args: string[]): Promise<string> {
  const ff = await getFFmpeg();
  let log = "";
  const handler = (e: LogEvent) => { log += e.message + "\n"; };
  ff.on("log", handler);
  try {
    await ff.exec(args);
  } catch { /* still want the log */ }
  ff.off("log", handler);
  return log;
}

export interface VideoProcessOptions {
  trimStart?: number;
  trimEnd?: number;
  removeAudio?: boolean;
  removeSubtitles?: boolean;
  eqBands?: { freq: number; gain: number }[];
  crop?: { x: number; y: number; w: number; h: number };
}

const MB_CROP_EXTS = new Set(["mp4", "m4v", "mov", "webm", "mkv"]);

/** Crop video using mediabunny (WebCodecs native encoder — much faster than FFmpeg WASM) */
async function cropWithMediabunny(
  inputBytes: Uint8Array,
  fileName: string,
  crop: { x: number; y: number; w: number; h: number },
  removeAudio: boolean,
  onProgress?: (pct: number) => void,
): Promise<Uint8Array> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "mp4";
  const isWebM = ext === "webm";
  const isMkv = ext === "mkv";

  const input = new Input({ formats: ALL_FORMATS, source: new MBBufferSource(inputBytes) });
  const duration = await input.computeDuration();
  if (!duration || duration <= 0) { input.dispose(); throw new Error("Cannot determine duration"); }

  const audioTrack = await input.getPrimaryAudioTrack();
  const hasAudio = !removeAudio && audioTrack !== null;

  const videoCodec = isWebM ? "vp9" as const : "avc" as const;
  const audioCodec = isWebM ? "opus" as const : "aac" as const;

  if (hasAudio && !await canEncodeAudio(audioCodec)) {
    input.dispose();
    throw new Error(`Browser cannot encode ${audioCodec}`);
  }

  // Match original video bitrate for similar file size
  const audioBytesEstimate = hasAudio ? (128000 / 8) * duration : 0;
  const originalVideoBitrate = ((inputBytes.length - audioBytesEstimate) * 8) / duration;
  const videoBitrate = Math.max(Math.floor(originalVideoBitrate), 100000);

  const fmt = isWebM ? new WebMOutputFormat() : isMkv ? new MkvOutputFormat() : new Mp4OutputFormat();
  const output = new Output({ format: fmt, target: new BufferTarget() });

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      crop: { left: crop.x, top: crop.y, width: crop.w, height: crop.h },
      codec: videoCodec,
      bitrate: videoBitrate,
      hardwareAcceleration: "prefer-hardware",
    },
    audio: hasAudio
      ? { codec: audioCodec, bitrate: 128000 }
      : { discard: true },
  });

  if (!conversion.isValid) { input.dispose(); throw new Error("Mediabunny conversion not valid"); }

  if (onProgress) {
    conversion.onProgress = (progress: number) => {
      onProgress(Math.min(Math.round(progress * 100), 99));
    };
  }

  await conversion.execute();
  const result = (output.target as BufferTarget).buffer;
  if (!result) throw new Error("No output buffer");
  return new Uint8Array(result);
}

/**
 * Process a video file: crop via WebCodecs (fast), FFmpeg for trim/EQ/subtitles.
 */
export async function processVideo(
  file: File,
  options: VideoProcessOptions,
  onProgress?: (pct: number) => void,
): Promise<FileData> {
  const hasEq = options.eqBands?.some(b => b.gain !== 0) ?? false;
  const hasCrop = !!options.crop;
  const hasTrim = (options.trimStart !== undefined && options.trimStart > 0) ||
    (options.trimEnd !== undefined && options.trimEnd < Infinity);
  const hasEdits = hasTrim || options.removeAudio || options.removeSubtitles || hasEq || hasCrop;

  if (!hasEdits) {
    const buf = await file.arrayBuffer();
    return { name: file.name, bytes: new Uint8Array(buf) };
  }

  const baseName = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";

  // Fast path: use mediabunny (WebCodecs) for crop when available
  if (hasCrop && typeof VideoEncoder !== "undefined" && MB_CROP_EXTS.has(ext)) {
    try {
      const hasFFmpegOps = hasTrim || options.removeSubtitles || hasEq;
      let intermediateBytes: Uint8Array;

      if (hasFFmpegOps) {
        // Phase 1: FFmpeg for trim/EQ/subtitles with stream copy (no crop, fast)
        intermediateBytes = await processWithFFmpeg(file, { ...options, crop: undefined }, onProgress);
      } else {
        intermediateBytes = new Uint8Array(await file.arrayBuffer());
      }

      // Phase 2: mediabunny for crop (native encoder, fast)
      const cropped = await cropWithMediabunny(
        intermediateBytes, file.name, options.crop!, options.removeAudio ?? false, onProgress,
      );
      return { name: baseName + "_edited." + ext, bytes: cropped };
    } catch (e) {
      console.warn("Mediabunny crop failed, falling back to FFmpeg:", e);
    }
  }

  // Fallback: FFmpeg for everything
  const resultBytes = await processWithFFmpeg(file, options, onProgress);
  return { name: baseName + "_edited." + ext, bytes: resultBytes };
}

/** FFmpeg fallback for all operations */
async function processWithFFmpeg(
  file: File,
  options: VideoProcessOptions,
  onProgress?: (pct: number) => void,
): Promise<Uint8Array> {
  const ff = await getFFmpeg();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
  const tmpIn = "vid_in." + ext;
  const tmpOut = "vid_out." + ext;

  const buf = await file.arrayBuffer();
  await ff.writeFile(tmpIn, new Uint8Array(buf));

  const args: string[] = [];

  // Trim via seeking
  if (options.trimStart !== undefined && options.trimStart > 0) {
    args.push("-ss", String(options.trimStart));
  }
  args.push("-i", tmpIn);
  if (options.trimEnd !== undefined && options.trimEnd < Infinity) {
    const duration = (options.trimEnd) - (options.trimStart ?? 0);
    if (duration > 0) args.push("-t", String(duration));
  }

  // Build filter chains
  const eqActive = !options.removeAudio && options.eqBands?.some(b => b.gain !== 0);
  const cropActive = !!options.crop;

  if (cropActive) {
    // Crop requires video re-encoding (can't stream-copy)
    const { x, y, w, h } = options.crop!;
    args.push("-vf", `crop=${w}:${h}:${x}:${y}`);
    args.push("-c:v", "libx264", "-preset", "ultrafast");
    if (eqActive) {
      // Re-encode audio with EQ filters too
      args.push("-c:a", "aac");
      const filters = options.eqBands!
        .filter(b => b.gain !== 0)
        .map(b => `equalizer=f=${b.freq}:width_type=o:width=2:g=${b.gain}`)
        .join(",");
      args.push("-af", filters);
    } else {
      args.push("-c:a", "copy");
    }
  } else if (eqActive) {
    // EQ only: re-encode audio, stream-copy video
    args.push("-c:v", "copy", "-c:a", "aac");
    const filters = options.eqBands!
      .filter(b => b.gain !== 0)
      .map(b => `equalizer=f=${b.freq}:width_type=o:width=2:g=${b.gain}`)
      .join(",");
    args.push("-af", filters);
  } else {
    args.push("-c", "copy");
  }
  if (options.removeAudio) args.push("-an");
  if (options.removeSubtitles) args.push("-sn");
  try { if (localStorage.getItem("convert-privacy") === "true") args.push("-map_metadata", "-1"); } catch {}

  args.push(tmpOut);

  // Progress tracking
  const progressHandler = (e: { progress?: number }) => {
    onProgress?.(Math.min(Math.round((e.progress ?? 0) * 100), 99));
  };
  ff.on("progress", progressHandler);

  try {
    await ffExec(args);
  } finally {
    ff.off("progress", progressHandler);
  }

  const data = await ff.readFile(tmpOut);
  const result = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
  await ff.deleteFile(tmpIn);
  await ff.deleteFile(tmpOut);
  return result;
}

export interface SubtitleStreamInfo {
  index: number;
  codec: string;
  language?: string;
}

export interface VideoProbeInfo {
  hasAudio: boolean;
  hasSubtitles: boolean;
  subtitleCount: number;
  subtitles: SubtitleStreamInfo[];
  duration: number;
  width: number;
  height: number;
}

/**
 * Probe a video file for audio/subtitle streams via FFmpeg.
 */
export async function probeVideoInfo(file: File): Promise<VideoProbeInfo> {
  const ff = await getFFmpeg();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
  const tmpIn = "probe_in." + ext;
  const buf = await file.arrayBuffer();
  await ff.writeFile(tmpIn, new Uint8Array(buf));

  const log = await ffExecWithLog(["-i", tmpIn, "-f", "null", "-"]);
  await ff.deleteFile(tmpIn);

  const hasAudio = /Stream.*Audio/.test(log);

  // Parse subtitle streams with index, language, and codec
  const subtitles: SubtitleStreamInfo[] = [];
  const subRegex = /Stream #0:(\d+)(?:\((\w+)\))?.*?Subtitle:\s*(\w+)/g;
  let subMatch;
  while ((subMatch = subRegex.exec(log)) !== null) {
    subtitles.push({
      index: parseInt(subMatch[1]),
      codec: subMatch[3].toLowerCase(),
      language: subMatch[2] || undefined,
    });
  }
  const hasSubtitles = subtitles.length > 0;
  const subtitleCount = subtitles.length;

  // Try to parse duration
  let duration = 0;
  const durMatch = log.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (durMatch) {
    duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
  }

  // Try to parse video resolution
  let width = 0, height = 0;
  const resMatch = log.match(/Stream.*Video.*?,\s*(\d{2,})x(\d{2,})/);
  if (resMatch) {
    width = parseInt(resMatch[1]);
    height = parseInt(resMatch[2]);
  }

  return { hasAudio, hasSubtitles, subtitleCount, subtitles, duration, width, height };
}

/**
 * Extract subtitle tracks from a video file.
 * Returns an array of FileData (one per subtitle track).
 */
export async function extractSubtitles(file: File, filterStreamIndex?: number): Promise<FileData[]> {
  const ff = await getFFmpeg();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
  const tmpIn = "sub_extract_in." + ext;
  const baseName = file.name.replace(/\.[^.]+$/, "");
  const buf = await file.arrayBuffer();
  await ff.writeFile(tmpIn, new Uint8Array(buf));

  // Probe for subtitle streams
  const log = await ffExecWithLog(["-i", tmpIn, "-f", "null", "-"]);
  let streamMatches = [...log.matchAll(/Stream #0:(\d+).*?Subtitle:\s*(\w+)/g)];

  // Filter to specific stream if requested
  if (filterStreamIndex !== undefined) {
    streamMatches = streamMatches.filter(m => parseInt(m[1]) === filterStreamIndex);
  }

  if (streamMatches.length === 0) {
    await ff.deleteFile(tmpIn);
    return [];
  }

  const results: FileData[] = [];
  for (const match of streamMatches) {
    const streamIndex = match[1];
    const codec = match[2].toLowerCase();
    const subExt = codec === "ass" ? "ass" : codec === "webvtt" || codec === "vtt" ? "vtt" : "srt";
    const outName = `sub_track_${streamIndex}.${subExt}`;

    try {
      await ffExec(["-i", tmpIn, "-map", `0:${streamIndex}`, outName]);
      const data = await ff.readFile(outName);
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
      results.push({ name: `${baseName}_track${streamIndex}.${subExt}`, bytes });
      await ff.deleteFile(outName);
    } catch {
      // Skip tracks that can't be extracted
    }
  }

  await ff.deleteFile(tmpIn);
  return results;
}

export interface AddSubtitleOptions {
  mode: "mux" | "burn";
}

/**
 * Add a subtitle file to a video.
 * - mux: embeds as a selectable track (fast, stream copy)
 * - burn: hardcodes into video frames (re-encodes video)
 */
export async function addSubtitlesToVideo(
  videoFile: File,
  subFile: File,
  options: AddSubtitleOptions,
  onProgress?: (pct: number) => void,
): Promise<FileData> {
  const ff = await getFFmpeg();
  const ext = videoFile.name.split(".").pop()?.toLowerCase() ?? "mp4";
  const subExt = subFile.name.split(".").pop()?.toLowerCase() ?? "srt";
  const baseName = videoFile.name.replace(/\.[^.]+$/, "");
  const tmpVid = "addsub_in." + ext;
  const tmpSub = "subs_in." + subExt;
  const tmpOut = "addsub_out." + ext;

  const vidBuf = await videoFile.arrayBuffer();
  await ff.writeFile(tmpVid, new Uint8Array(vidBuf));
  const subBuf = await subFile.arrayBuffer();
  await ff.writeFile(tmpSub, new Uint8Array(subBuf));

  const progressHandler = (e: { progress?: number }) => {
    onProgress?.(Math.min(Math.round((e.progress ?? 0) * 100), 99));
  };
  ff.on("progress", progressHandler);

  const privacyArgs: string[] = [];
  try { if (localStorage.getItem("convert-privacy") === "true") privacyArgs.push("-map_metadata", "-1"); } catch {}

  try {
    if (options.mode === "mux") {
      await ffExec(["-i", tmpVid, "-i", tmpSub, "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", ...privacyArgs, tmpOut]);
    } else {
      // burn: re-encode with subtitle filter
      await ffExec(["-i", tmpVid, "-vf", `subtitles=${tmpSub}`, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "copy", ...privacyArgs, tmpOut]);
    }
  } finally {
    ff.off("progress", progressHandler);
  }

  const data = await ff.readFile(tmpOut);
  const result = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
  await ff.deleteFile(tmpVid);
  await ff.deleteFile(tmpSub);
  await ff.deleteFile(tmpOut);

  const suffix = options.mode === "mux" ? "_subbed" : "_burned";
  return { name: `${baseName}${suffix}.${ext}`, bytes: result };
}

/**
 * Merge multiple video files via FFmpeg concat demuxer.
 * Default: stream copy for speed. Set reEncode=true for mixed-format files.
 * Auto-retries with re-encode if stream copy fails.
 */
export async function mergeVideos(
  files: File[],
  reEncode: boolean = false,
  onProgress?: (pct: number) => void,
): Promise<FileData> {
  if (files.length < 2) throw new Error("Need at least 2 files to merge");

  const ff = await getFFmpeg();
  const ext = files[0].name.split(".").pop()?.toLowerCase() ?? "mp4";
  const baseName = files[0].name.replace(/\.[^.]+$/, "");
  const tmpOut = "merge_out." + ext;

  // Write all files to FS
  const tmpNames: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const name = `merge_${i}.${files[i].name.split(".").pop()?.toLowerCase() ?? ext}`;
    tmpNames.push(name);
    const buf = await files[i].arrayBuffer();
    await ff.writeFile(name, new Uint8Array(buf));
  }

  // Build concat list
  const listContent = tmpNames.map(n => `file '${n}'`).join("\n");
  await ff.writeFile("concat_list.txt", new TextEncoder().encode(listContent));

  const progressHandler = (e: { progress?: number }) => {
    onProgress?.(Math.min(Math.round((e.progress ?? 0) * 100), 99));
  };
  ff.on("progress", progressHandler);

  const buildArgs = (encode: boolean) => {
    const a = ["-f", "concat", "-safe", "0", "-i", "concat_list.txt"];
    if (encode) {
      // Re-encode for compatibility
      a.push("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac");
    } else {
      a.push("-c", "copy");
    }
    try { if (localStorage.getItem("convert-privacy") === "true") a.push("-map_metadata", "-1"); } catch {}
    a.push(tmpOut);
    return a;
  };

  try {
    try {
      await ffExec(buildArgs(reEncode));
    } catch (e) {
      if (!reEncode) {
        // Auto-retry with re-encode
        try { await ff.deleteFile(tmpOut); } catch {}
        await ffExec(buildArgs(true));
      } else {
        throw e;
      }
    }
  } finally {
    ff.off("progress", progressHandler);
  }

  const data = await ff.readFile(tmpOut);
  const result = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);

  // Cleanup
  for (const name of tmpNames) {
    try { await ff.deleteFile(name); } catch {}
  }
  try { await ff.deleteFile("concat_list.txt"); } catch {}
  try { await ff.deleteFile(tmpOut); } catch {}

  return { name: `${baseName}_merged.${ext}`, bytes: result };
}

/**
 * Extract audio from video as WAV (16kHz mono) for Whisper transcription.
 */
export async function extractAudioAsWav(file: File): Promise<Uint8Array> {
  let ff: FFmpeg;
  try {
    ff = await getFFmpeg();
  } catch {
    ff = await reloadFFmpeg();
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
  const tmpIn = "whisper_in." + ext;
  const tmpOut = "whisper_out.wav";

  const buf = await file.arrayBuffer();
  await ff.writeFile(tmpIn, new Uint8Array(buf));

  await ffExec(["-i", tmpIn, "-ar", "16000", "-ac", "1", "-f", "wav", tmpOut]);

  const data = await ff.readFile(tmpOut);
  const result = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
  await ff.deleteFile(tmpIn);
  await ff.deleteFile(tmpOut);
  return result;
}

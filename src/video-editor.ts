import type { FileData } from "./FormatHandler.ts";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { LogEvent } from "@ffmpeg/ffmpeg";

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
}

/**
 * Process a video file: trim + audio removal via MediaBunny, FFmpeg fallback for subtitle removal.
 */
export async function processVideo(
  file: File,
  options: VideoProcessOptions,
  onProgress?: (pct: number) => void,
): Promise<FileData> {
  const hasEdits = (options.trimStart !== undefined && options.trimStart > 0) ||
    (options.trimEnd !== undefined && options.trimEnd < Infinity) ||
    options.removeAudio || options.removeSubtitles;

  if (!hasEdits) {
    const buf = await file.arrayBuffer();
    return { name: file.name, bytes: new Uint8Array(buf) };
  }

  const baseName = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
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

  args.push("-c", "copy");
  if (options.removeAudio) args.push("-an");
  if (options.removeSubtitles) args.push("-sn");

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

  return { hasAudio, hasSubtitles, subtitleCount, subtitles, duration };
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

  try {
    if (options.mode === "mux") {
      await ffExec(["-i", tmpVid, "-i", tmpSub, "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", tmpOut]);
    } else {
      // burn: re-encode with subtitle filter
      await ffExec(["-i", tmpVid, "-vf", `subtitles=${tmpSub}`, "-c:a", "copy", tmpOut]);
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

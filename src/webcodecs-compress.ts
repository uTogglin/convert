import type { FileData } from "./FormatHandler.ts";
import {
  Input, Output, Conversion, BufferSource, BufferTarget,
  Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat,
  ALL_FORMATS,
} from "mediabunny";

const SUPPORTED_EXTS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "ts"]);

function updatePopupHeading(text: string) {
  const popup = document.getElementById("popup");
  if (popup) {
    const h2 = popup.querySelector("h2");
    if (h2) h2.textContent = text;
  }
}

function resetProgressBar() {
  const bar = document.getElementById("compress-progress-bar");
  const pctEl = document.getElementById("compress-progress-pct");
  if (bar) bar.style.width = "0%";
  if (pctEl) pctEl.textContent = "0%";
}

export function isWebCodecsAvailable(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";
}

interface ConversionOptions {
  videoCodec: string;
  videoBitrate: number;
  audioCodec: string;
  hasAudio: boolean;
  hwAccel: "prefer-hardware" | "prefer-software";
  audioBitrate?: number;
  frameRate?: number;
}

export async function compressVideoWebCodecs(
  file: FileData,
  targetBytes: number,
  encoderSpeed: "fast" | "balanced" | "quality" = "balanced",
  crf?: number,
  codec: "h264" | "h265" = "h264"
): Promise<FileData | null> {
  if (!isWebCodecsAvailable()) return null;

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return null;

  const isWebM = ext === "webm";
  const isMkv = ext === "mkv";

  function makeOutput(forWebM = isWebM, forMkv = isMkv) {
    const fmt = forWebM ? new WebMOutputFormat() : forMkv ? new MkvOutputFormat() : new Mp4OutputFormat();
    return new Output({ format: fmt, target: new BufferTarget() });
  }

  function makeInput() {
    return new Input({ formats: ALL_FORMATS, source: new BufferSource(file.bytes) });
  }

  try {
    const input = makeInput();
    const duration = await input.computeDuration();
    if (!duration || duration <= 0) return null;

    const audioTrack = await input.getPrimaryAudioTrack();
    const hasAudio = audioTrack !== null;

    // Video codec selection
    const videoCodec = isWebM ? "vp9" : codec === "h265" ? "hevc" : "avc";
    const audioCodec = isWebM ? "opus" : "aac";

    // Speed preset → hardware acceleration preference
    let hwAccel: "prefer-hardware" | "prefer-software" = encoderSpeed === "quality"
      ? "prefer-software"
      : "prefer-hardware";

    // ── Bitrate calculation ──
    let videoBitrate: number;
    if (targetBytes > 0) {
      const safeTarget = targetBytes * 0.97;
      const audioBits = hasAudio ? 96000 : 0;
      const totalBitrate = (safeTarget * 8) / duration;
      const targetVideoBitrate = totalBitrate - audioBits;

      // Estimate original video bitrate to gauge compression difficulty
      const audioBytesEstimate = hasAudio ? (96000 / 8) * duration : 0;
      const originalVideoBitrate = ((file.bytes.length - audioBytesEstimate) * 8) / duration;
      const compressionRatio = targetVideoBitrate / originalVideoBitrate;

      // Adaptive efficiency curve based on compression difficulty
      const efficiency = Math.min(0.40 + compressionRatio * 0.75, 0.92);

      // Skip hardware for very aggressive compression
      if (compressionRatio < 0.4 && hwAccel === "prefer-hardware") {
        hwAccel = "prefer-software";
      }

      videoBitrate = Math.max(Math.floor(targetVideoBitrate * efficiency), 50000);
    } else if (crf !== undefined) {
      const inputBitrate = (file.bytes.length * 8) / duration;
      const crfScale = Math.pow(2, (23 - crf) / 6);
      videoBitrate = Math.max(Math.floor(inputBitrate * crfScale * 0.5), 50000);
    } else {
      return null;
    }

    // ── First attempt ──
    const result = await attemptConversion(makeInput(), makeOutput(), {
      videoCodec, videoBitrate, audioCodec, hasAudio, hwAccel,
    });

    if (!result) return null;

    // Re-encode mode: if larger than original, keep original
    if (result.byteLength >= file.bytes.length && targetBytes <= 0) return file;

    // Success: under target
    if (targetBytes > 0 && result.byteLength <= targetBytes) {
      return { name: file.name, bytes: new Uint8Array(result) };
    }

    // No target mode and result is smaller than original
    if (targetBytes <= 0) {
      return { name: file.name, bytes: new Uint8Array(result) };
    }

    // ── Overshot target — enter escalating strategy loop ──
    let lastBitrate = videoBitrate;
    let lastSize = result.byteLength;
    let bestResult: ArrayBuffer | null = result;
    let bestSize = result.byteLength;
    let bestName = file.name;

    // Helper: calibrate bitrate from last measured result
    const calibrate = (base: number, actual: number) =>
      Math.max(Math.floor(base * (targetBytes / actual) * 0.90), 50000);

    // Helper: update tracking after an attempt
    const track = (res: ArrayBuffer | null, usedBitrate: number, name: string) => {
      if (!res) return;
      if (res.byteLength <= targetBytes) return; // handled by caller
      if (res.byteLength < bestSize) {
        bestResult = res;
        bestSize = res.byteLength;
        bestName = name;
      }
      lastBitrate = usedBitrate;
      lastSize = res.byteLength;
    };

    // Strategy 1: Calibrated bitrate, same encoder
    {
      updatePopupHeading("Calibrating bitrate...");
      resetProgressBar();
      const br = calibrate(lastBitrate, lastSize);
      const res = await attemptConversion(makeInput(), makeOutput(), {
        videoCodec, videoBitrate: br, audioCodec, hasAudio, hwAccel,
      });
      if (res && res.byteLength <= targetBytes) return { name: file.name, bytes: new Uint8Array(res) };
      track(res, br, file.name);
    }

    // Strategy 2: Software encoder + lower audio (64kbps)
    {
      updatePopupHeading("Trying lower audio bitrate...");
      resetProgressBar();
      const br = calibrate(lastBitrate, lastSize);
      const res = await attemptConversion(makeInput(), makeOutput(), {
        videoCodec, videoBitrate: br, audioCodec, hasAudio,
        hwAccel: "prefer-software", audioBitrate: 64000,
      });
      if (res && res.byteLength <= targetBytes) return { name: file.name, bytes: new Uint8Array(res) };
      track(res, br, file.name);
    }

    // Strategy 3: VP9 codec (much more efficient at low bitrates)
    if (videoCodec !== "vp9") {
      updatePopupHeading("Trying VP9 codec...");
      resetProgressBar();
      const br = calibrate(lastBitrate, lastSize);
      const vp9Name = file.name.replace(/\.[^.]+$/, ".webm");
      const res = await attemptConversion(makeInput(), makeOutput(true, false), {
        videoCodec: "vp9", videoBitrate: br, audioCodec: "opus", hasAudio,
        hwAccel: "prefer-software", audioBitrate: 64000,
      });
      if (res && res.byteLength <= targetBytes) return { name: vp9Name, bytes: new Uint8Array(res) };
      track(res, br, vp9Name);
    }

    // Strategy 4: VP9 + slightly reduced framerate (subtle 2fps drop)
    {
      updatePopupHeading("Trying VP9 with lower framerate...");
      resetProgressBar();
      const br = calibrate(lastBitrate, lastSize);
      const useVp9 = videoCodec !== "vp9";
      const stratName = useVp9 ? file.name.replace(/\.[^.]+$/, ".webm") : file.name;
      const res = await attemptConversion(makeInput(), useVp9 ? makeOutput(true, false) : makeOutput(), {
        videoCodec: useVp9 ? "vp9" : videoCodec,
        videoBitrate: br,
        audioCodec: useVp9 ? "opus" : audioCodec,
        hasAudio,
        hwAccel: "prefer-software", audioBitrate: 64000,
        frameRate: 28,
      });
      if (res && res.byteLength <= targetBytes) return { name: stratName, bytes: new Uint8Array(res) };
      track(res, br, stratName);
    }

    // Strategy 5: Re-compress the best result (already close to target — much easier to shrink)
    if (bestResult && bestSize < targetBytes * 1.5) {
      updatePopupHeading("Re-compressing closest result...");
      resetProgressBar();

      const bestBytes = new Uint8Array(bestResult);
      const bestExt = (bestName.split(".").pop() ?? "").toLowerCase();
      const reIsWebM = bestExt === "webm";
      const reIsMkv = bestExt === "mkv";

      const reInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(bestBytes) });
      const reDuration = await reInput.computeDuration();

      if (reDuration && reDuration > 0) {
        const reAudioTrack = await reInput.getPrimaryAudioTrack();
        const reHasAudio = reAudioTrack !== null;
        const reVideoCodec = reIsWebM ? "vp9" : videoCodec;
        const reAudioCodec = reIsWebM ? "opus" : audioCodec;

        // Calculate bitrate from the best result's actual size
        const reAudioBits = reHasAudio ? 64000 : 0;
        const reTotalBitrate = (targetBytes * 0.95 * 8) / reDuration;
        const reBitrate = Math.max(Math.floor((reTotalBitrate - reAudioBits) * 0.90), 50000);

        const reOutput = new Output({
          format: reIsWebM ? new WebMOutputFormat() : reIsMkv ? new MkvOutputFormat() : new Mp4OutputFormat(),
          target: new BufferTarget(),
        });

        const res = await attemptConversion(reInput, reOutput, {
          videoCodec: reVideoCodec, videoBitrate: reBitrate,
          audioCodec: reAudioCodec, hasAudio: reHasAudio,
          hwAccel: "prefer-software", audioBitrate: 64000,
        });

        if (res && res.byteLength <= targetBytes) {
          return { name: bestName, bytes: new Uint8Array(res) };
        }
      }
    }

    return null; // All strategies exhausted, fall back to ffmpeg
  } catch (e) {
    console.warn(`WebCodecs compression failed for "${file.name}":`, e);
    return null;
  }
}

async function attemptConversion(
  input: Input,
  output: Output,
  opts: ConversionOptions
): Promise<ArrayBuffer | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoConfig: any = {
    codec: opts.videoCodec as "avc" | "hevc" | "vp9",
    bitrate: opts.videoBitrate,
    hardwareAcceleration: opts.hwAccel,
    forceTranscode: true,
  };
  if (opts.frameRate) videoConfig.frameRate = opts.frameRate;

  const conversion = await Conversion.init({
    input,
    output,
    video: videoConfig,
    audio: opts.hasAudio
      ? { codec: opts.audioCodec as "aac" | "opus", bitrate: opts.audioBitrate ?? 96000 }
      : { discard: true },
  });

  if (!conversion.isValid) {
    const videoDiscarded = conversion.discardedTracks.some(
      t => t.reason === "no_encodable_target_codec" || t.reason === "undecodable_source_codec"
    );
    if (videoDiscarded) return null;
  }

  conversion.onProgress = (progress: number) => {
    const pct = Math.min(Math.round(progress * 100), 99);
    const bar = document.getElementById("compress-progress-bar");
    const pctEl = document.getElementById("compress-progress-pct");
    if (bar) bar.style.width = pct + "%";
    if (pctEl) pctEl.textContent = pct + "%";
  };

  await conversion.execute();
  return (output.target as BufferTarget).buffer;
}

import type { FileData } from "./FormatHandler.ts";
import {
  Input, Output, Conversion, BufferSource, BufferTarget,
  Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat,
  ALL_FORMATS, canEncodeAudio,
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

// Cache codec support checks to avoid repeated async lookups
const codecSupportCache = new Map<string, boolean>();
async function isCodecEncodingSupported(codec: "vp9" | "avc" | "hevc"): Promise<boolean> {
  if (codecSupportCache.has(codec)) return codecSupportCache.get(codec)!;
  const codecStrings: Record<string, string> = {
    vp9: "vp09.00.10.08",
    avc: "avc1.42001f",
    hevc: "hev1.1.6.L93.B0",
  };
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: codecStrings[codec], width: 640, height: 480, bitrate: 1_000_000,
    });
    const supported = result.supported === true;
    codecSupportCache.set(codec, supported);
    return supported;
  } catch {
    codecSupportCache.set(codec, false);
    return false;
  }
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
  codec: "h264" | "h265" = "h264",
  webmMode?: boolean
): Promise<FileData | null> {
  if (!isWebCodecsAvailable()) return null;

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return null;

  const isWebM = ext === "webm";
  const isMkv = ext === "mkv";
  // WebM mode: treat non-WebM files as if targeting WebM output
  const useWebmMode = webmMode && !isWebM;
  const effectiveWebM = isWebM || useWebmMode;

  function makeOutput(forWebM = effectiveWebM, forMkv = useWebmMode ? false : isMkv) {
    const fmt = forWebM ? new WebMOutputFormat() : forMkv ? new MkvOutputFormat() : new Mp4OutputFormat();
    return new Output({ format: fmt, target: new BufferTarget() });
  }

  function makeInput() {
    return new Input({ formats: ALL_FORMATS, source: new BufferSource(file.bytes) });
  }

  // Output filename: swap extension to .webm when webmMode overrides format
  const outputName = useWebmMode ? file.name.replace(/\.[^.]+$/, ".webm") : file.name;

  try {
    const input = makeInput();
    const duration = await input.computeDuration();
    if (!duration || duration <= 0) return null;

    const audioTrack = await input.getPrimaryAudioTrack();
    const hasAudio = audioTrack !== null;

    // Probe original framerate for subtle fps drop in later strategies
    const videoTrack = await input.getPrimaryVideoTrack();
    const packetStats = videoTrack ? await videoTrack.computePacketStats() : null;
    const originalFps = packetStats?.averagePacketRate ?? 0;
    const reducedFps = originalFps > 4 ? Math.round(originalFps) - 2 : 0; // e.g. 60→58, 30→28

    // Video codec selection
    const videoCodec = effectiveWebM ? "vp9" : codec === "h265" ? "hevc" : "avc";
    const audioCodec = effectiveWebM ? "opus" : "aac";

    // Skip WebCodecs entirely if the browser can't encode the needed audio codec
    if (hasAudio && !await canEncodeAudio(audioCodec as "aac" | "opus")) return null;

    // Speed preset → hardware acceleration preference
    let hwAccel: "prefer-hardware" | "prefer-software" = encoderSpeed === "quality"
      ? "prefer-software"
      : "prefer-hardware";

    // ── Bitrate calculation ──
    let videoBitrate: number;
    let generousBitrate = 0; // target bitrate without efficiency penalty (for VP9 first-pass)
    if (targetBytes > 0) {
      const safeTarget = targetBytes * 0.97;
      const audioBits = hasAudio ? 96000 : 0;
      const totalBitrate = (safeTarget * 8) / duration;
      const targetVideoBitrate = totalBitrate - audioBits;
      generousBitrate = Math.max(Math.floor(targetVideoBitrate * 0.95), 50000);

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

    // Verify the chosen codec is supported before attempting
    const primaryCodecKey = videoCodec === "vp9" ? "vp9" : videoCodec === "hevc" ? "hevc" : "avc";
    if (!await isCodecEncodingSupported(primaryCodecKey as "vp9" | "avc" | "hevc")) return null;

    // ── First attempt ──
    const result = await attemptConversion(makeInput(), makeOutput(), {
      videoCodec, videoBitrate, audioCodec, hasAudio, hwAccel,
    });

    if (!result) return null;

    // Re-encode mode: if larger than original, keep original
    if (result.byteLength >= file.bytes.length && targetBytes <= 0) return file;

    // Success: under target
    if (targetBytes > 0 && result.byteLength <= targetBytes) {
      return { name: outputName, bytes: new Uint8Array(result) };
    }

    // No target mode and result is smaller than original
    if (targetBytes <= 0) {
      return { name: outputName, bytes: new Uint8Array(result) };
    }

    // ── Overshot target — enter escalating strategy loop ──
    // 1. Calibrated bitrate, same encoder (HW retry if first was HW)
    // 2. Software encoder + lower audio (64kbps)
    // 3. Re-compress closest result
    // Then: ffmpeg fallback (in compress.ts), then VP9 last resort (changes format)

    let lastBitrate = videoBitrate;
    let lastSize = result.byteLength;
    let bestResult: ArrayBuffer | null = result;
    let bestSize = result.byteLength;
    let bestName = outputName;

    // Helper: calibrate bitrate from last measured result
    // Safety factor scales with overshoot: gentle for near-misses, aggressive for big misses
    const calibrate = (base: number, actual: number) => {
      const overshoot = actual / targetBytes;           // 1.1 = 10% over, 2.0 = 100% over
      const safety = overshoot > 1.5 ? 0.78
                   : overshoot > 1.2 ? 0.85
                   : 0.93;
      return Math.max(Math.floor(base * (targetBytes / actual) * safety), 50000);
    };

    // Helper: update tracking after an attempt
    const track = (res: ArrayBuffer | null, usedBitrate: number, name: string) => {
      if (!res) return;
      if (res.byteLength <= targetBytes) return;
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
      if (res && res.byteLength <= targetBytes) return { name: outputName, bytes: new Uint8Array(res) };
      track(res, br, outputName);
    }

    // Strategy 2: Software encoder + lower audio (64kbps) + subtle fps drop
    {
      updatePopupHeading("Trying lower audio bitrate...");
      resetProgressBar();
      const br = calibrate(lastBitrate, lastSize);
      const res = await attemptConversion(makeInput(), makeOutput(), {
        videoCodec, videoBitrate: br, audioCodec, hasAudio,
        hwAccel: "prefer-software", audioBitrate: 64000,
        ...(reducedFps > 0 ? { frameRate: reducedFps } : {}),
      });
      if (res && res.byteLength <= targetBytes) return { name: outputName, bytes: new Uint8Array(res) };
      track(res, br, outputName);
    }

    // ── Strategy 3: Re-compress the closest result ──
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

        const reAudioBits = reHasAudio ? 64000 : 0;
        const reTotalBitrate = (targetBytes * 0.95 * 8) / reDuration;
        const reOvershoot = bestSize / targetBytes;
        const reSafety = reOvershoot > 1.5 ? 0.78 : reOvershoot > 1.2 ? 0.85 : 0.93;
        const reBitrate = Math.max(Math.floor((reTotalBitrate - reAudioBits) * reSafety), 50000);

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

  // If audio was expected but got discarded, bail out so ffmpeg can handle it
  if (opts.hasAudio && conversion.discardedTracks.some(t => t.track.isAudioTrack())) {
    return null;
  }

  if (!conversion.isValid) {
    const hasCodecIssue = conversion.discardedTracks.some(
      t => t.reason === "no_encodable_target_codec" || t.reason === "undecodable_source_codec"
    );
    if (hasCodecIssue) return null;
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

/**
 * Last-resort VP9 compression. Outputs WebM (changes format).
 * Called after ffmpeg fallback when original codec can't hit target.
 */
export async function compressVideoVP9(
  file: FileData,
  targetBytes: number,
): Promise<FileData | null> {
  if (!isWebCodecsAvailable()) return null;

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (ext === "webm") return null; // Already WebM, VP9 won't help

  if (!await isCodecEncodingSupported("vp9")) return null;

  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(file.bytes) });
    const duration = await input.computeDuration();
    if (!duration || duration <= 0) return null;

    const hasAudio = (await input.getPrimaryAudioTrack()) !== null;
    if (hasAudio && !await canEncodeAudio("opus")) return null;
    const audioBits = hasAudio ? 64000 : 0;
    const totalBitrate = (targetBytes * 0.95 * 8) / duration;
    let bitrate = Math.max(Math.floor((totalBitrate - audioBits) * 0.90), 50000);

    const vp9Name = file.name.replace(/\.[^.]+$/, ".webm");

    // Up to 2 calibrated attempts
    for (let attempt = 0; attempt < 2; attempt++) {
      updatePopupHeading(attempt === 0 ? "Trying VP9 codec..." : "Calibrating VP9...");
      resetProgressBar();

      const res = await attemptConversion(
        new Input({ formats: ALL_FORMATS, source: new BufferSource(file.bytes) }),
        new Output({ format: new WebMOutputFormat(), target: new BufferTarget() }),
        {
          videoCodec: "vp9", videoBitrate: bitrate, audioCodec: "opus", hasAudio,
          hwAccel: "prefer-software", audioBitrate: 64000,
        },
      );

      if (!res) return null;
      if (res.byteLength <= targetBytes) return { name: vp9Name, bytes: new Uint8Array(res) };

      // Calibrate for next attempt — scale safety with overshoot
      const vp9Overshoot = res.byteLength / targetBytes;
      const vp9Safety = vp9Overshoot > 1.5 ? 0.78 : vp9Overshoot > 1.2 ? 0.85 : 0.93;
      bitrate = Math.max(Math.floor(bitrate * (targetBytes / res.byteLength) * vp9Safety), 50000);
    }

    return null;
  } catch {
    return null;
  }
}

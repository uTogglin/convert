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

/**
 * Re-encode a VP9 WebM result back to the original container/codec.
 * If the conversion overshoots target, runs calibrated retries in the
 * original format (no further format changes) until target is hit.
 * Returns null only if the codec is unsupported or decoding fails.
 */
async function convertBackToOriginal(
  webmBytes: Uint8Array,
  targetBytes: number,
  originalVideoCodec: string,
  originalAudioCodec: string,
  originalName: string,
  isOrigWebM: boolean,
  isOrigMkv: boolean,
): Promise<FileData | null> {
  try {
    const mkInput = () => new Input({ formats: ALL_FORMATS, source: new BufferSource(webmBytes) });
    const mkOutput = () => {
      const fmt = isOrigWebM ? new WebMOutputFormat() : isOrigMkv ? new MkvOutputFormat() : new Mp4OutputFormat();
      return new Output({ format: fmt, target: new BufferTarget() });
    };

    const probe = mkInput();
    const duration = await probe.computeDuration();
    if (!duration || duration <= 0) return null;

    const hasAudio = (await probe.getPrimaryAudioTrack()) !== null;
    const audioBits = hasAudio ? 64000 : 0;
    const totalBitrate = (targetBytes * 0.95 * 8) / duration;
    let bitrate = Math.max(Math.floor((totalBitrate - audioBits) * 0.92), 50000);

    // Up to 3 attempts with calibrated bitrate
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        updatePopupHeading("Adjusting bitrate...");
        resetProgressBar();
      }

      const res = await attemptConversion(mkInput(), mkOutput(), {
        videoCodec: originalVideoCodec,
        videoBitrate: bitrate,
        audioCodec: "opus", // Keep Opus from the VP9 intermediate — AAC encoding isn't supported by WebCodecs
        hasAudio,
        hwAccel: "prefer-software",
        audioBitrate: 64000,
      });

      if (!res) return null; // codec unsupported

      if (res.byteLength <= targetBytes) {
        return { name: originalName, bytes: new Uint8Array(res) };
      }

      // Calibrate for next attempt
      bitrate = Math.max(Math.floor(bitrate * (targetBytes / res.byteLength) * 0.90), 50000);
    }

    return null; // Still over after retries
  } catch {
    return null;
  }
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
    const needsFormatConvert = !isWebM; // VP9 results need converting back for non-WebM inputs

    // Helper: if VP9 succeeded, convert back to original format; fall back to WebM if that fails
    const returnVp9Result = async (webmBytes: Uint8Array, tb: number): Promise<FileData> => {
      if (!needsFormatConvert) return { name: file.name, bytes: webmBytes };
      updatePopupHeading("Converting back to " + ext.toUpperCase() + "...");
      resetProgressBar();
      const converted = await convertBackToOriginal(
        webmBytes, tb, videoCodec, audioCodec, file.name, isWebM, isMkv
      );
      return converted ?? { name: file.name.replace(/\.[^.]+$/, ".webm"), bytes: webmBytes };
    };

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
      return { name: file.name, bytes: new Uint8Array(result) };
    }

    // No target mode and result is smaller than original
    if (targetBytes <= 0) {
      return { name: file.name, bytes: new Uint8Array(result) };
    }

    // ── Overshot target — enter escalating strategy loop ──
    // Phase 1: Codec efficiency (preserve quality — let VP9 do the heavy lifting)
    // Phase 2: Measured lossy targeting (calibrated from previous attempts)
    // Phase 3: Re-compress closest result

    let lastBitrate = videoBitrate;
    let lastSize = result.byteLength;
    let bestResult: ArrayBuffer | null = result;
    let bestSize = result.byteLength;
    let bestName = file.name;
    const vp9Name = file.name.replace(/\.[^.]+$/, ".webm");

    // Helper: calibrate bitrate from last measured result
    const calibrate = (base: number, actual: number) =>
      Math.max(Math.floor(base * (targetBytes / actual) * 0.90), 50000);

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

    // ── Phase 1: Codec efficiency first (generous bitrate, less lossy) ──

    // Check codec support upfront to skip strategies that can't work
    const vp9Supported = videoCodec !== "vp9" ? await isCodecEncodingSupported("vp9") : true;

    // Strategy 1: VP9 at generous bitrate — codec efficiency alone may hit target
    if (videoCodec !== "vp9" && vp9Supported) {
      updatePopupHeading("Trying VP9 codec...");
      resetProgressBar();
      const res = await attemptConversion(makeInput(), makeOutput(true, false), {
        videoCodec: "vp9", videoBitrate: generousBitrate, audioCodec: "opus", hasAudio,
        hwAccel: "prefer-software",
      });
      if (res && res.byteLength <= targetBytes) return await returnVp9Result(new Uint8Array(res), targetBytes);
      track(res, generousBitrate, vp9Name);
    }

    // Strategy 2: VP9 + lower audio (64kbps) — save audio budget for video
    if (videoCodec !== "vp9" && vp9Supported && hasAudio) {
      updatePopupHeading("Trying VP9 with lower audio...");
      resetProgressBar();
      const res = await attemptConversion(makeInput(), makeOutput(true, false), {
        videoCodec: "vp9", videoBitrate: generousBitrate, audioCodec: "opus", hasAudio,
        hwAccel: "prefer-software", audioBitrate: 64000,
      });
      if (res && res.byteLength <= targetBytes) return await returnVp9Result(new Uint8Array(res), targetBytes);
      track(res, generousBitrate, vp9Name);
    }

    // ── Phase 2: Calibrated lossy targeting (measured from previous attempts) ──

    // Strategy 3: VP9 with calibrated bitrate from measured data
    {
      updatePopupHeading("Calibrating bitrate...");
      resetProgressBar();
      const br = calibrate(lastBitrate, lastSize);
      const useVp9 = videoCodec !== "vp9" && vp9Supported;
      const name = useVp9 ? vp9Name : file.name;
      const res = await attemptConversion(makeInput(), useVp9 ? makeOutput(true, false) : makeOutput(), {
        videoCodec: useVp9 ? "vp9" : videoCodec,
        videoBitrate: br,
        audioCodec: useVp9 ? "opus" : audioCodec,
        hasAudio,
        hwAccel: "prefer-software", audioBitrate: 64000,
      });
      if (res && res.byteLength <= targetBytes) {
        if (useVp9) return await returnVp9Result(new Uint8Array(res), targetBytes);
        return { name, bytes: new Uint8Array(res) };
      }
      track(res, br, name);
    }

    // Strategy 4: Original codec with calibrated bitrate + 64k audio
    {
      updatePopupHeading("Calibrating bitrate...");
      resetProgressBar();
      const br = calibrate(lastBitrate, lastSize);
      const res = await attemptConversion(makeInput(), makeOutput(), {
        videoCodec, videoBitrate: br, audioCodec, hasAudio,
        hwAccel: "prefer-software", audioBitrate: 64000,
      });
      if (res && res.byteLength <= targetBytes) return { name: file.name, bytes: new Uint8Array(res) };
      track(res, br, file.name);
    }

    // ── Phase 3: Re-compress the closest result ──
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
          const isVp9Result = bestName.endsWith(".webm") && needsFormatConvert;
          if (isVp9Result) return await returnVp9Result(new Uint8Array(res), targetBytes);
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
    const critical = conversion.discardedTracks.some(t => {
      const reason = t.reason === "no_encodable_target_codec" || t.reason === "undecodable_source_codec";
      if (!reason) return false;
      // Video discarded → always fail
      if (t.type === "video") return true;
      // Audio discarded when we expected audio → fail (avoids silent audio loss)
      if (t.type === "audio" && opts.hasAudio) return true;
      return false;
    });
    if (critical) return null;
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

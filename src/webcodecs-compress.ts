import type { FileData } from "./FormatHandler.ts";
import {
  Input, Output, Conversion, BufferSource, BufferTarget,
  Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat,
  ALL_FORMATS,
} from "mediabunny";

const SUPPORTED_EXTS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "ts"]);

export function isWebCodecsAvailable(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";
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

  // Determine output format matching the input container
  const outputFormat = isWebM
    ? new WebMOutputFormat()
    : isMkv
      ? new MkvOutputFormat()
      : new Mp4OutputFormat();

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(file.bytes),
  });

  const output = new Output({
    format: outputFormat,
    target: new BufferTarget(),
  });

  try {
    const duration = await input.computeDuration();
    if (!duration || duration <= 0) return null;

    const audioTrack = await input.getPrimaryAudioTrack();
    const hasAudio = audioTrack !== null;

    // Video codec selection
    const videoCodec = isWebM ? "vp9" : codec === "h265" ? "hevc" : "avc";
    const audioCodec = isWebM ? "opus" : "aac";

    // Speed preset → hardware acceleration preference
    const hwAccel = encoderSpeed === "quality"
      ? "prefer-software" as const
      : "prefer-hardware" as const;

    // Bitrate calculation
    let videoBitrate: number;
    if (targetBytes > 0) {
      const safeTarget = targetBytes * 0.97;
      const audioBits = hasAudio ? 96000 : 0;
      const totalBitrate = (safeTarget * 8) / duration;
      videoBitrate = Math.max(Math.floor(totalBitrate - audioBits), 50000);
    } else if (crf !== undefined) {
      // Map CRF to approximate bitrate based on input file stats
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) return null;
      const inputBitrate = (file.bytes.length * 8) / duration;
      const crfScale = Math.pow(2, (23 - crf) / 6);
      videoBitrate = Math.max(Math.floor(inputBitrate * crfScale * 0.5), 50000);
    } else {
      return null;
    }

    const result = await attemptConversion(
      input, output, videoCodec, videoBitrate, audioCodec, hasAudio, hwAccel
    );

    if (!result) return null;

    // If larger than original, keep original
    if (result.byteLength >= file.bytes.length) return file;

    // If target size mode and overshot, retry at lower bitrate
    if (targetBytes > 0 && result.byteLength > targetBytes) {
      const retryRatio = (targetBytes / result.byteLength) * 0.95;
      const retryBitrate = Math.max(Math.floor(videoBitrate * retryRatio), 50000);

      const retryOutput = new Output({
        format: isWebM ? new WebMOutputFormat() : isMkv ? new MkvOutputFormat() : new Mp4OutputFormat(),
        target: new BufferTarget(),
      });
      const retryInput = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(file.bytes),
      });

      const retryResult = await attemptConversion(
        retryInput, retryOutput, videoCodec, retryBitrate, audioCodec, hasAudio, hwAccel
      );

      if (retryResult && retryResult.byteLength <= targetBytes) {
        return { name: file.name, bytes: new Uint8Array(retryResult) };
      }
      return null; // Still over target, fall back to ffmpeg
    }

    return { name: file.name, bytes: new Uint8Array(result) };
  } catch (e) {
    console.warn(`WebCodecs compression failed for "${file.name}":`, e);
    return null;
  }
}

async function attemptConversion(
  input: Input,
  output: Output,
  videoCodec: string,
  videoBitrate: number,
  audioCodec: string,
  hasAudio: boolean,
  hwAccel: "prefer-hardware" | "prefer-software"
): Promise<ArrayBuffer | null> {
  const conversion = await Conversion.init({
    input,
    output,
    video: {
      codec: videoCodec as "avc" | "hevc" | "vp9",
      bitrate: videoBitrate,
      hardwareAcceleration: hwAccel,
      forceTranscode: true,
    },
    audio: hasAudio
      ? { codec: audioCodec as "aac" | "opus", bitrate: 96000 }
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

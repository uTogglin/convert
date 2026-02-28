import type { FileData } from "./FormatHandler.ts";
import { extractAudioAsWav } from "./video-editor.ts";

let whisperPipeline: any = null;
let whisperLoading = false;

/**
 * Check if the Whisper model has been loaded into memory.
 */
export function isWhisperLoaded(): boolean {
  return whisperPipeline !== null;
}

/**
 * Format seconds to SRT timestamp: HH:MM:SS,mmm
 */
function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return (
    String(h).padStart(2, "0") + ":" +
    String(m).padStart(2, "0") + ":" +
    String(s).padStart(2, "0") + "," +
    String(ms).padStart(3, "0")
  );
}

/**
 * Generate subtitles from a video file using Whisper AI.
 * Returns an SRT file as FileData.
 */
export async function generateSubtitles(
  file: File,
  onProgress?: (stage: string, pct: number) => void,
): Promise<FileData> {
  // Step 1: Extract audio as WAV (16kHz mono)
  onProgress?.("Extracting audio...", 5);
  const wavBytes = await extractAudioAsWav(file);

  // Step 2: Load Whisper model (lazy, cached by browser)
  if (!whisperPipeline) {
    if (whisperLoading) {
      // Wait for an in-progress load
      while (whisperLoading && !whisperPipeline) {
        await new Promise(r => setTimeout(r, 200));
      }
    } else {
      whisperLoading = true;
      onProgress?.("Downloading model...", 10);

      try {
        const { pipeline } = await import("@huggingface/transformers");
        whisperPipeline = await pipeline(
          "automatic-speech-recognition",
          "Xenova/whisper-tiny.en",
          {
            progress_callback: (info: any) => {
              if (info.status === "progress" && typeof info.progress === "number") {
                // Map model download progress to 10-50% range
                const pct = Math.round(10 + (info.progress * 0.4));
                onProgress?.("Downloading model...", pct);
              }
            },
          },
        );
      } finally {
        whisperLoading = false;
      }
    }
  }

  if (!whisperPipeline) throw new Error("Failed to load Whisper model");

  // Step 3: Run transcription
  onProgress?.("Transcribing...", 55);

  // Convert WAV bytes to a Float32Array for Whisper
  // WAV format: 44 byte header, then PCM data (16-bit LE)
  const audioData = new Float32Array((wavBytes.length - 44) / 2);
  const dataView = new DataView(wavBytes.buffer, wavBytes.byteOffset + 44);
  for (let i = 0; i < audioData.length; i++) {
    audioData[i] = dataView.getInt16(i * 2, true) / 32768;
  }

  const result = await whisperPipeline(audioData, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  onProgress?.("Formatting subtitles...", 90);

  // Step 4: Format output as SRT
  const chunks: Array<{ text: string; timestamp: [number, number | null] }> =
    result.chunks || [];

  if (chunks.length === 0 && result.text) {
    // Fallback: single chunk for entire text
    chunks.push({ text: result.text.trim(), timestamp: [0, null] });
  }

  let srt = "";
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const start = chunk.timestamp[0] ?? 0;
    const end = chunk.timestamp[1] ?? (chunks[i + 1]?.timestamp[0] ?? start + 5);
    const text = chunk.text.trim();
    if (!text) continue;

    srt += `${i + 1}\n`;
    srt += `${formatSrtTime(start)} --> ${formatSrtTime(end)}\n`;
    srt += `${text}\n\n`;
  }

  if (!srt.trim()) {
    srt = "1\n00:00:00,000 --> 00:00:05,000\n(No speech detected)\n\n";
  }

  onProgress?.("Done!", 100);

  const baseName = file.name.replace(/\.[^.]+$/, "");
  const encoder = new TextEncoder();
  return {
    name: `${baseName}_subtitles.srt`,
    bytes: encoder.encode(srt),
  };
}

import type { FileData } from "./FormatHandler.ts";
import { extractAudioAsWav } from "./video-editor.ts";

const whisperPipelines: Map<string, any> = new Map();
let whisperLoadingKey: string | null = null;
let detectedDevice: "webgpu" | "wasm" | null = null;

interface ModelConfig {
  id: string;
  label: string;
  size: string;
}

const MODELS: Record<string, ModelConfig> = {
  base: { id: "onnx-community/whisper-base", label: "Base", size: "~50 MB" },
  small: { id: "onnx-community/whisper-small", label: "Small", size: "~160 MB" },
  medium: { id: "Xenova/whisper-medium", label: "Medium", size: "~500 MB" },
  "large-v3-turbo": { id: "onnx-community/whisper-large-v3-turbo", label: "Large V3 Turbo", size: "~550 MB" },
};

async function getWhisperDevice(): Promise<"webgpu" | "wasm"> {
  if (detectedDevice) return detectedDevice;
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator &&
    !!(await navigator.gpu?.requestAdapter().catch(() => null));
  detectedDevice = hasWebGPU ? "webgpu" : "wasm";
  console.log(`[Whisper STT] Using device=${detectedDevice}`);
  return detectedDevice;
}

function getWhisperDtype(modelKey: string, device: "webgpu" | "wasm"): any {
  // Whisper encoder is very sensitive to quantization — keep it at fp16 minimum.
  // Decoder can be aggressively quantized to q4 with minimal quality loss.
  if (device === "webgpu") {
    if (modelKey === "large-v3-turbo" || modelKey === "medium") {
      // Per-module dtype: fp16 encoder saves ~50% VRAM vs fp32, q4 decoder for speed
      return { encoder_model: "fp16", decoder_model_merged: "q4" };
    }
    // base / small are small enough for fp32 on GPU
    return "fp32";
  }
  // WASM fallback — q8 for smaller models, q4 for large ones
  if (modelKey === "large-v3-turbo") return "q4";
  return "q8";
}

/**
 * Check if any Whisper model has been loaded into memory.
 */
export function isWhisperLoaded(): boolean {
  return whisperPipelines.size > 0;
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

export interface GenerateSubtitleOptions {
  language?: string;
  model?: "base" | "small" | "medium" | "large-v3-turbo";
}

/**
 * Generate subtitles from a video file using Whisper AI.
 * Returns an SRT file as FileData.
 */
export async function generateSubtitles(
  file: File,
  onProgress?: (stage: string, pct: number) => void,
  options?: GenerateSubtitleOptions,
): Promise<FileData> {
  const modelKey = options?.model || "large-v3-turbo";
  const cfg = MODELS[modelKey];
  if (!cfg) throw new Error(`Unknown Whisper model: ${modelKey}`);
  const modelId = cfg.id;
  const language = options?.language || undefined;

  // Step 1: Extract audio as WAV (16kHz mono)
  onProgress?.("Extracting audio...", 5);
  const wavBytes = await extractAudioAsWav(file);

  // Step 2: Load Whisper model (lazy, cached per model key)
  let whisperPipeline = whisperPipelines.get(modelKey);
  if (!whisperPipeline) {
    if (whisperLoadingKey === modelKey) {
      // Wait for an in-progress load
      while (whisperLoadingKey === modelKey && !whisperPipelines.has(modelKey)) {
        await new Promise(r => setTimeout(r, 200));
      }
      whisperPipeline = whisperPipelines.get(modelKey);
    } else {
      whisperLoadingKey = modelKey;
      onProgress?.(`Loading ${cfg.label} model...`, 10);

      try {
        const { pipeline } = await import("@huggingface/transformers");
        const device = await getWhisperDevice();
        const dtype = getWhisperDtype(modelKey, device);
        const dtypeLabel = typeof dtype === "string" ? dtype : "mixed";
        onProgress?.(`Loading ${cfg.label} model (${device}, ${dtypeLabel})...`, 10);

        // Track whether files are coming from cache or network
        let fromCache = true;

        whisperPipeline = await pipeline(
          "automatic-speech-recognition",
          modelId,
          {
            dtype,
            device: device as any,
            progress_callback: (info: any) => {
              if (info.status === "progress" && typeof info.progress === "number") {
                // If we see slow progress (loaded < total for a while), it's a real download
                if (info.loaded && info.total && info.loaded < info.total * 0.99) {
                  fromCache = false;
                }
                const pct = Math.round(10 + (info.progress * 0.4));
                const file = info.file ? info.file.split("/").pop() : "";
                const loaded = info.loaded ? (info.loaded / 1024 / 1024).toFixed(1) : "?";
                const total = info.total ? (info.total / 1024 / 1024).toFixed(1) : "?";
                const action = fromCache ? "Loading" : "Downloading";
                const msg = `${action} ${cfg.label} — ${file} (${loaded}/${total} MB)`;
                console.log(`[Whisper STT] ${msg} [${Math.round(info.progress)}%]`);
                onProgress?.(msg, pct);
              } else if (info.status === "initiate") {
                const file = info.file ? info.file.split("/").pop() : "";
                console.log(`[Whisper STT] Loading: ${file}`);
                onProgress?.(`Loading ${cfg.label} — ${file}...`, 10);
              } else if (info.status === "done") {
                const file = info.file ? info.file.split("/").pop() : "";
                console.log(`[Whisper STT] Ready: ${file}`);
              } else if (info.status === "ready") {
                console.log(`[Whisper STT] Model ${cfg.label} ready (${device}, ${dtypeLabel})`);
                onProgress?.(`${cfg.label} model loaded!`, 50);
              }
            },
          },
        );

        // WebGPU fix: ONNX tensors stay on GPU — patch model.__call__ to force CPU readback
        if (device === "webgpu" && whisperPipeline.model?.__call__) {
          const origCall = whisperPipeline.model.__call__.bind(whisperPipeline.model);
          whisperPipeline.model.__call__ = async function (...args: any[]) {
            const output = await origCall(...args);
            for (const key of Object.keys(output)) {
              const tensor = output[key];
              if (tensor && typeof tensor.getData === "function") {
                await tensor.getData();
              }
            }
            return output;
          };
          console.log("[Whisper STT] Patched model.__call__ for WebGPU tensor readback");
        }

        whisperPipelines.set(modelKey, whisperPipeline);
      } finally {
        whisperLoadingKey = null;
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

  const pipelineOpts: any = {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  if (language) {
    pipelineOpts.language = language;
    pipelineOpts.task = "transcribe";
  }

  const result = await whisperPipeline(audioData, pipelineOpts);

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

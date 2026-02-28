import { FFmpeg } from "@ffmpeg/ffmpeg";

// ── FFmpeg instance for WAV→MP3 ────────────────────────────────────────────
let speechFFmpeg: FFmpeg | null = null;
let speechFFmpegReady: Promise<void> | null = null;

async function getSpeechFFmpeg(): Promise<FFmpeg> {
  if (!speechFFmpeg) speechFFmpeg = new FFmpeg();
  if (!speechFFmpegReady) speechFFmpegReady = speechFFmpeg.load({ coreURL: "/wasm/ffmpeg-core.js" }).then(() => {});
  await speechFFmpegReady;
  return speechFFmpeg;
}

// ── Lazy Kokoro TTS instance ───────────────────────────────────────────────
let kokoroInstance: any = null;
let kokoroLoading: Promise<any> | null = null;

async function getKokoro(onProgress?: (pct: number, msg: string) => void): Promise<any> {
  if (kokoroInstance) return kokoroInstance;
  if (kokoroLoading) { await kokoroLoading; return kokoroInstance; }

  kokoroLoading = (async () => {
    const { KokoroTTS } = await import("kokoro-js");

    // Prefer WebGPU (fast, GPU-accelerated) with WASM fallback
    let device = "wasm";
    let dtype = "q8"; // q8 for WASM (CPU-optimized, 92MB)
    try {
      if ("gpu" in navigator) {
        const adapter = await (navigator as any).gpu.requestAdapter();
        if (adapter) {
          device = "webgpu";
          dtype = "fp16"; // fp16 for WebGPU (GPU-compatible, 163MB)
        }
      }
    } catch { /* no WebGPU */ }

    console.log(`[Kokoro TTS] Using device=${device}, dtype=${dtype}`);
    onProgress?.(0, `Loading Kokoro model (${device})...`);

    kokoroInstance = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      {
        dtype: dtype as any,
        device: device as any,
        progress_callback: (info: any) => {
          if (info.status === "progress" && typeof info.progress === "number") {
            onProgress?.(Math.round(info.progress), `Downloading Kokoro model (${device})...`);
          }
        },
      },
    );
    console.log("[Kokoro TTS] Model loaded successfully");
  })();

  try {
    await kokoroLoading;
  } catch (err) {
    kokoroLoading = null;
    throw err;
  }
  return kokoroInstance;
}

// ── SVG icons ──────────────────────────────────────────────────────────────
const PLAY_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
const PAUSE_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;

// ── WAV encoder for concatenated Float32Array chunks ───────────────────────
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Write PCM samples (float → 16-bit int)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Word timing structure ──────────────────────────────────────────────────
interface WordTiming {
  word: string;
  start: number;
  end: number;
  el: HTMLSpanElement;
}

// ── Init ───────────────────────────────────────────────────────────────────
export function initSpeechTool() {
  // DOM refs
  const tabs = document.querySelectorAll<HTMLButtonElement>(".speech-tab");
  const ttsPanel = document.getElementById("speech-tts-panel") as HTMLDivElement;
  const sttPanel = document.getElementById("speech-stt-panel") as HTMLDivElement;

  // TTS refs
  const ttsInput = document.getElementById("speech-tts-input") as HTMLTextAreaElement;
  const ttsVoice = document.getElementById("speech-tts-voice") as HTMLSelectElement;
  const ttsSpeed = document.getElementById("speech-tts-speed") as HTMLInputElement;
  const ttsSpeedLabel = document.getElementById("speech-tts-speed-label") as HTMLSpanElement;
  const generateBtn = document.getElementById("speech-tts-generate") as HTMLButtonElement;
  const ttsProgress = document.getElementById("speech-tts-progress") as HTMLDivElement;
  const ttsProgressFill = ttsProgress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const ttsProgressText = ttsProgress.querySelector(".speech-progress-text") as HTMLSpanElement;
  const freezeWarning = ttsProgress.querySelector(".speech-freeze-warning") as HTMLParagraphElement;

  // Player refs
  const player = document.getElementById("speech-player") as HTMLDivElement;
  const wordDisplay = document.getElementById("speech-word-display") as HTMLDivElement;
  const audio = document.getElementById("speech-audio") as HTMLAudioElement;
  const playBtn = document.getElementById("speech-play-btn") as HTMLButtonElement;
  const skipBack = document.getElementById("speech-skip-back") as HTMLButtonElement;
  const skipForward = document.getElementById("speech-skip-forward") as HTMLButtonElement;
  const seekBar = document.getElementById("speech-seek-bar") as HTMLDivElement;
  const seekFill = document.getElementById("speech-seek-fill") as HTMLDivElement;
  const seekThumb = document.getElementById("speech-seek-thumb") as HTMLDivElement;
  const timeDisplay = document.getElementById("speech-time-display") as HTMLSpanElement;
  const downloadBtn = document.getElementById("speech-download-mp3") as HTMLButtonElement;

  // STT refs
  const sttModes = document.querySelectorAll<HTMLButtonElement>(".speech-stt-mode");
  const sttMicContent = document.getElementById("speech-stt-mic") as HTMLDivElement;
  const sttFileContent = document.getElementById("speech-stt-file") as HTMLDivElement;
  const sttLang = document.getElementById("speech-stt-lang") as HTMLSelectElement;
  const recordBtn = document.getElementById("speech-stt-record") as HTMLButtonElement;
  const sttFileLang = document.getElementById("speech-stt-file-lang") as HTMLSelectElement;
  const sttFileModel = document.getElementById("speech-stt-file-model") as HTMLSelectElement;
  const fileDrop = document.getElementById("speech-file-drop") as HTMLDivElement;
  const fileInput = document.getElementById("speech-file-input") as HTMLInputElement;
  const fileName = document.getElementById("speech-stt-file-name") as HTMLSpanElement;
  const transcribeBtn = document.getElementById("speech-stt-transcribe") as HTMLButtonElement;
  const sttProgress = document.getElementById("speech-stt-progress") as HTMLDivElement;
  const sttProgressFill = sttProgress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const sttProgressText = sttProgress.querySelector(".speech-progress-text") as HTMLSpanElement;
  const sttOutput = document.getElementById("speech-stt-output") as HTMLDivElement;
  const sttResult = document.getElementById("speech-stt-result") as HTMLTextAreaElement;
  const sttCopy = document.getElementById("speech-stt-copy") as HTMLButtonElement;

  // State
  let currentWavBlob: Blob | null = null;
  let currentAudioUrl: string | null = null;
  let wordTimings: WordTiming[] = [];
  let activeWordIdx = -1;
  let sttFile: File | null = null;
  let recognition: any = null;
  let isRecording = false;

  // Set initial play icon
  playBtn.innerHTML = PLAY_SVG;

  function setPlayIcon(playing: boolean) {
    playBtn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  }

  // ── Tab switching ──────────────────────────────────────────────────────
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      ttsPanel.classList.toggle("active", which === "tts");
      sttPanel.classList.toggle("active", which === "stt");
    });
  }

  // ── STT mode switching ─────────────────────────────────────────────────
  for (const mode of sttModes) {
    mode.addEventListener("click", () => {
      sttModes.forEach(m => m.classList.remove("active"));
      mode.classList.add("active");
      const which = mode.dataset.mode;
      sttMicContent.classList.toggle("active", which === "mic");
      sttFileContent.classList.toggle("active", which === "file");
    });
  }

  // ── Speed slider ───────────────────────────────────────────────────────
  ttsSpeed.addEventListener("input", () => {
    ttsSpeedLabel.textContent = `${parseFloat(ttsSpeed.value).toFixed(1)}x`;
  });

  // ── Build word display with spans ──────────────────────────────────────
  function buildWordDisplay(text: string): HTMLSpanElement[] {
    wordDisplay.innerHTML = "";
    const words = text.split(/(\s+)/); // preserve whitespace
    const spans: HTMLSpanElement[] = [];
    for (const token of words) {
      if (/^\s+$/.test(token)) {
        wordDisplay.appendChild(document.createTextNode(token));
      } else {
        const span = document.createElement("span");
        span.className = "speech-word";
        span.textContent = token;
        wordDisplay.appendChild(span);
        spans.push(span);
      }
    }
    return spans;
  }

  // ── Build timing map from stream chunks ────────────────────────────────
  function buildTimings(
    chunks: Array<{ text: string; samples: number }>,
    sampleRate: number,
    wordSpans: HTMLSpanElement[],
  ): WordTiming[] {
    const timings: WordTiming[] = [];
    let sampleOffset = 0;
    let spanIdx = 0;

    for (const chunk of chunks) {
      const chunkStart = sampleOffset / sampleRate;
      const chunkEnd = (sampleOffset + chunk.samples) / sampleRate;
      const chunkWords = chunk.text.trim().split(/\s+/).filter(Boolean);

      if (chunkWords.length === 0) {
        sampleOffset += chunk.samples;
        continue;
      }

      const timePerWord = (chunkEnd - chunkStart) / chunkWords.length;
      for (let i = 0; i < chunkWords.length; i++) {
        const el = wordSpans[spanIdx];
        if (!el) break;
        timings.push({
          word: chunkWords[i],
          start: chunkStart + i * timePerWord,
          end: chunkStart + (i + 1) * timePerWord,
          el,
        });
        spanIdx++;
      }
      sampleOffset += chunk.samples;
    }
    return timings;
  }

  // ── Highlight current word during playback ─────────────────────────────
  function updateWordHighlight() {
    if (wordTimings.length === 0) return;
    const t = audio.currentTime;
    let newIdx = -1;
    for (let i = 0; i < wordTimings.length; i++) {
      if (t >= wordTimings[i].start && t < wordTimings[i].end) {
        newIdx = i;
        break;
      }
    }
    // If past all words, highlight last
    if (newIdx === -1 && t >= wordTimings[wordTimings.length - 1]?.start) {
      newIdx = wordTimings.length - 1;
    }
    if (newIdx !== activeWordIdx) {
      if (activeWordIdx >= 0 && activeWordIdx < wordTimings.length) {
        wordTimings[activeWordIdx].el.classList.remove("active");
      }
      if (newIdx >= 0) {
        wordTimings[newIdx].el.classList.add("active");
        // Scroll into view if needed
        const container = wordDisplay;
        const el = wordTimings[newIdx].el;
        if (el.offsetTop < container.scrollTop || el.offsetTop + el.offsetHeight > container.scrollTop + container.clientHeight) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
      activeWordIdx = newIdx;
    }
  }

  // ── TTS Generate (Kokoro streaming) ────────────────────────────────────
  let generating = false;

  generateBtn.addEventListener("click", async () => {
    const text = ttsInput.value.trim();
    if (!text || generating) return;

    generating = true;
    generateBtn.classList.add("disabled");
    ttsProgress.classList.remove("hidden");
    ttsProgressFill.style.width = "0%";
    ttsProgressText.textContent = "Loading Kokoro TTS model...";
    freezeWarning.classList.add("hidden");
    player.classList.add("hidden");

    try {
      const tts = await getKokoro((pct, msg) => {
        ttsProgressFill.style.width = `${Math.round(pct * 0.6)}%`;
        ttsProgressText.textContent = msg;
      });

      ttsProgressText.textContent = "Generating speech...";
      ttsProgressFill.style.width = "65%";
      freezeWarning.classList.remove("hidden");

      const voice = ttsVoice.value;
      const speed = parseFloat(ttsSpeed.value);

      // Build word display from input text
      const wordSpans = buildWordDisplay(text);

      // Use streaming to handle long text — collect all chunks
      const audioChunks: Float32Array[] = [];
      const chunkMeta: Array<{ text: string; samples: number }> = [];
      let sampleRate = 24000;

      console.log("[Kokoro TTS] Starting generation...", { voice, speed, textLength: text.length });

      // Split text into sentence-sized chunks for generate()
      // (stream() hangs on WebGPU, so we chunk manually)
      const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
      const chunks: string[] = [];
      let current = "";
      for (const s of sentences) {
        if (current.length + s.length > 300 && current) {
          chunks.push(current.trim());
          current = s;
        } else {
          current += s;
        }
      }
      if (current.trim()) chunks.push(current.trim());

      console.log(`[Kokoro TTS] Split into ${chunks.length} chunk(s)`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[Kokoro TTS] Generating chunk ${i + 1}/${chunks.length}: "${chunk.substring(0, 50)}..."`);
        ttsProgressText.textContent = chunks.length > 1
          ? `Generating speech (${i + 1}/${chunks.length})...`
          : "Generating speech...";
        ttsProgressFill.style.width = `${Math.min(95, 65 + (i / chunks.length) * 30)}%`;

        const result = await tts.generate(chunk, { voice, speed });
        const data: Float32Array = result.data;
        sampleRate = result.sampling_rate || 24000;
        audioChunks.push(data);
        chunkMeta.push({ text: chunk, samples: data.length });
        console.log(`[Kokoro TTS] Chunk ${i + 1} done: ${data.length} samples`);
      }
      console.log("[Kokoro TTS] All chunks generated");

      ttsProgressFill.style.width = "95%";
      ttsProgressText.textContent = "Encoding audio...";
      freezeWarning.classList.add("hidden");

      // Concatenate all chunks into one Float32Array
      const totalSamples = audioChunks.reduce((sum, c) => sum + c.length, 0);
      const fullAudio = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of audioChunks) {
        fullAudio.set(chunk, offset);
        offset += chunk.length;
      }

      // Build word timing map
      wordTimings = buildTimings(chunkMeta, sampleRate, wordSpans);
      activeWordIdx = -1;

      // Encode to WAV
      currentWavBlob = encodeWav(fullAudio, sampleRate);

      // Load into audio player
      if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = URL.createObjectURL(currentWavBlob);
      audio.src = currentAudioUrl;
      audio.load();

      ttsProgressFill.style.width = "100%";
      ttsProgressText.textContent = "Done!";

      player.classList.remove("hidden");
      setTimeout(() => { ttsProgress.classList.add("hidden"); }, 600);

    } catch (err: any) {
      console.error("TTS generation failed:", err);
      ttsProgressText.textContent = `Error: ${err?.message || "Generation failed."}`;
      freezeWarning.classList.add("hidden");
    } finally {
      generating = false;
      generateBtn.classList.remove("disabled");
    }
  });

  // ── Playback controls ─────────────────────────────────────────────────
  playBtn.addEventListener("click", () => {
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  });

  audio.addEventListener("play", () => setPlayIcon(true));
  audio.addEventListener("pause", () => setPlayIcon(false));
  audio.addEventListener("ended", () => {
    setPlayIcon(false);
    // Clear word highlight on end
    if (activeWordIdx >= 0 && activeWordIdx < wordTimings.length) {
      wordTimings[activeWordIdx].el.classList.remove("active");
    }
    activeWordIdx = -1;
  });

  skipBack.addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  skipForward.addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });

  // ── Progress / seek bar + word highlighting ────────────────────────────
  audio.addEventListener("timeupdate", () => {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    seekFill.style.width = `${pct}%`;
    seekThumb.style.left = `${pct}%`;
    timeDisplay.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
    updateWordHighlight();
  });

  audio.addEventListener("loadedmetadata", () => {
    timeDisplay.textContent = `0:00 / ${formatTime(audio.duration)}`;
  });

  let seeking = false;

  function seekTo(e: MouseEvent | Touch) {
    const rect = seekBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = pct * audio.duration;
  }

  seekBar.addEventListener("mousedown", (e) => {
    seeking = true;
    seekTo(e);
  });
  window.addEventListener("mousemove", (e) => { if (seeking) seekTo(e); });
  window.addEventListener("mouseup", () => { seeking = false; });

  seekBar.addEventListener("touchstart", (e) => {
    seeking = true;
    seekTo(e.touches[0]);
  }, { passive: true });
  window.addEventListener("touchmove", (e) => { if (seeking) seekTo(e.touches[0]); }, { passive: true });
  window.addEventListener("touchend", () => { seeking = false; });

  // ── MP3 download ───────────────────────────────────────────────────────
  let downloading = false;

  downloadBtn.addEventListener("click", async () => {
    if (!currentWavBlob || downloading) return;
    downloading = true;
    downloadBtn.textContent = "Converting...";

    try {
      const wavBytes = new Uint8Array(await currentWavBlob.arrayBuffer());

      const ff = await getSpeechFFmpeg();
      await ff.writeFile("input.wav", wavBytes);
      const code = await ff.exec(["-i", "input.wav", "-codec:a", "libmp3lame", "-qscale:a", "2", "output.mp3"]);
      if (typeof code === "number" && code !== 0) throw new Error(`FFmpeg exit code ${code}`);
      const mp3Data = await ff.readFile("output.mp3") as Uint8Array;
      await ff.deleteFile("input.wav").catch(() => {});
      await ff.deleteFile("output.mp3").catch(() => {});

      const blob = new Blob([mp3Data as BlobPart], { type: "audio/mpeg" });
      downloadBlob(blob, "speech.mp3");
    } catch (err) {
      console.error("MP3 conversion failed:", err);
    } finally {
      downloading = false;
      downloadBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Download MP3`;
    }
  });

  // ── STT: Microphone (Web Speech API) ───────────────────────────────────
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  recordBtn.addEventListener("click", () => {
    if (!SpeechRecognition) {
      sttOutput.classList.remove("hidden");
      sttResult.value = "Speech recognition is not supported in this browser. Try Chrome or Edge.";
      return;
    }

    if (isRecording && recognition) {
      recognition.stop();
      return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = sttLang.value;

    let finalTranscript = sttResult.value;

    recognition.onstart = () => {
      isRecording = true;
      recordBtn.classList.add("recording");
      const dot = recordBtn.querySelector(".speech-record-dot");
      if (dot) {
        recordBtn.textContent = "";
        recordBtn.appendChild(dot);
        recordBtn.append(" Stop Recording");
      }
    };

    recognition.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalTranscript += transcript + " ";
        } else {
          interim += transcript;
        }
      }
      sttOutput.classList.remove("hidden");
      sttResult.value = finalTranscript + interim;
    };

    recognition.onerror = (e: any) => {
      console.error("Speech recognition error:", e.error);
      if (e.error === "not-allowed") {
        sttOutput.classList.remove("hidden");
        sttResult.value = "Microphone access denied. Please allow microphone access and try again.";
      }
      stopRecording();
    };

    recognition.onend = () => {
      stopRecording();
    };

    recognition.start();
  });

  function stopRecording() {
    isRecording = false;
    recordBtn.classList.remove("recording");
    const dot = recordBtn.querySelector(".speech-record-dot");
    if (dot) {
      recordBtn.textContent = "";
      recordBtn.appendChild(dot);
      recordBtn.append(" Start Recording");
    }
  }

  // ── STT: File upload ───────────────────────────────────────────────────
  fileDrop.addEventListener("click", () => fileInput.click());

  fileDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    fileDrop.classList.add("dragover");
  });
  fileDrop.addEventListener("dragleave", () => {
    fileDrop.classList.remove("dragover");
  });
  fileDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileDrop.classList.remove("dragover");
    const file = e.dataTransfer?.files[0];
    if (file) loadSTTFile(file);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) loadSTTFile(fileInput.files[0]);
    fileInput.value = "";
  });

  function loadSTTFile(file: File) {
    sttFile = file;
    fileName.textContent = file.name;
    transcribeBtn.classList.remove("disabled");
  }

  transcribeBtn.addEventListener("click", async () => {
    if (!sttFile || transcribeBtn.classList.contains("disabled")) return;

    transcribeBtn.classList.add("disabled");
    sttProgress.classList.remove("hidden");
    sttProgressFill.style.width = "0%";
    sttProgressText.textContent = "Extracting audio...";

    try {
      const { generateSubtitles } = await import("./subtitle-generator.ts");

      const language = sttFileLang.value || undefined;
      const model = sttFileModel.value as "base" | "small";

      const result = await generateSubtitles(sttFile, (stage, pct) => {
        sttProgressFill.style.width = `${pct}%`;
        sttProgressText.textContent = stage;
      }, { language, model });

      const srtText = new TextDecoder().decode(result.bytes);
      const plainText = srtText
        .split("\n")
        .filter(line => {
          if (/^\d+$/.test(line.trim())) return false;
          if (/-->/.test(line)) return false;
          if (!line.trim()) return false;
          return true;
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      sttOutput.classList.remove("hidden");
      sttResult.value = plainText || "(No speech detected)";

    } catch (err) {
      console.error("Transcription failed:", err);
      sttProgressText.textContent = "Error during transcription.";
      sttOutput.classList.remove("hidden");
      sttResult.value = "Transcription failed. Check the error log for details.";
    } finally {
      transcribeBtn.classList.remove("disabled");
      setTimeout(() => sttProgress.classList.add("hidden"), 800);
    }
  });

  // ── Copy button ────────────────────────────────────────────────────────
  sttCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(sttResult.value);
      const original = sttCopy.innerHTML;
      sttCopy.textContent = "Copied!";
      setTimeout(() => { sttCopy.innerHTML = original; }, 1500);
    } catch {
      sttResult.select();
      document.execCommand("copy");
    }
  });
}

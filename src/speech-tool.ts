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
    kokoroInstance = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      {
        dtype: "q8" as any,
        device: "wasm" as any,
        progress_callback: (info: any) => {
          if (info.status === "progress" && typeof info.progress === "number") {
            onProgress?.(Math.round(info.progress), "Downloading Kokoro model...");
          }
        },
      },
    );
  })();

  try {
    await kokoroLoading;
  } catch (err) {
    kokoroLoading = null;
    throw err;
  }
  return kokoroInstance;
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

  // Player refs
  const player = document.getElementById("speech-player") as HTMLDivElement;
  const audio = document.getElementById("speech-audio") as HTMLAudioElement;
  const playBtn = document.getElementById("speech-play-btn") as HTMLButtonElement;
  const iconPlay = playBtn.querySelector(".speech-icon-play") as SVGElement;
  const iconPause = playBtn.querySelector(".speech-icon-pause") as SVGElement;
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
  let sttFile: File | null = null;
  let recognition: any = null;
  let isRecording = false;

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

  // ── TTS Generate (Kokoro) ─────────────────────────────────────────────
  let generating = false;

  generateBtn.addEventListener("click", async () => {
    const text = ttsInput.value.trim();
    if (!text || generating) return;

    generating = true;
    generateBtn.classList.add("disabled");
    ttsProgress.classList.remove("hidden");
    ttsProgressFill.style.width = "0%";
    ttsProgressText.textContent = "Loading Kokoro TTS model...";
    player.classList.add("hidden");

    try {
      const tts = await getKokoro((pct, msg) => {
        ttsProgressFill.style.width = `${Math.round(pct * 0.6)}%`;
        ttsProgressText.textContent = msg;
      });

      ttsProgressText.textContent = "Generating speech...";
      ttsProgressFill.style.width = "65%";

      const voice = ttsVoice.value;
      const speed = parseFloat(ttsSpeed.value);

      const result = await tts.generate(text, { voice, speed });

      ttsProgressFill.style.width = "90%";
      ttsProgressText.textContent = "Encoding audio...";

      // Get WAV blob from Kokoro output
      currentWavBlob = result.toBlob();

      // Load into audio player
      if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = URL.createObjectURL(currentWavBlob);
      audio.src = currentAudioUrl;
      audio.load();

      ttsProgressFill.style.width = "100%";
      ttsProgressText.textContent = "Done!";

      player.classList.remove("hidden");
      setTimeout(() => { ttsProgress.classList.add("hidden"); }, 600);

    } catch (err) {
      console.error("TTS generation failed:", err);
      ttsProgressText.textContent = "Error generating audio.";
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

  audio.addEventListener("play", () => {
    iconPlay.classList.add("hidden");
    iconPause.classList.remove("hidden");
  });
  audio.addEventListener("pause", () => {
    iconPlay.classList.remove("hidden");
    iconPause.classList.add("hidden");
  });
  audio.addEventListener("ended", () => {
    iconPlay.classList.remove("hidden");
    iconPause.classList.add("hidden");
  });

  skipBack.addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  skipForward.addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });

  // ── Progress / seek bar ────────────────────────────────────────────────
  audio.addEventListener("timeupdate", () => {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    seekFill.style.width = `${pct}%`;
    seekThumb.style.left = `${pct}%`;
    timeDisplay.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
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
      // Convert Blob to Uint8Array for FFmpeg
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

      // Extract plain text from SRT result
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

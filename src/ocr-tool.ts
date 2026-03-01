import { getKokoro, encodeWav, spokenWeight } from "./speech-tool.js";

// ── Lazy Tesseract worker ──────────────────────────────────────────────────
let ocrWorker: any = null;
let ocrWorkerLoading: Promise<any> | null = null;
let loadedLang: string | null = null;

async function getOcrWorker(lang: string, onProgress?: (pct: number, msg: string) => void): Promise<any> {
  if (ocrWorker && loadedLang === lang) return ocrWorker;
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; ocrWorkerLoading = null; }

  if (ocrWorkerLoading) { await ocrWorkerLoading; return ocrWorker; }

  ocrWorkerLoading = (async () => {
    const Tesseract = await import("tesseract.js");
    onProgress?.(0, `Loading OCR engine (${lang})...`);
    const worker = await Tesseract.createWorker(lang, undefined, {
      logger: (m: any) => {
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          onProgress?.(Math.round(m.progress * 100), "Recognizing text...");
        } else if (m.status === "loading tesseract core") {
          onProgress?.(5, "Loading OCR engine...");
        } else if (m.status === "loading language traineddata") {
          onProgress?.(10, `Downloading ${lang} language data...`);
        } else if (m.status === "initializing api") {
          onProgress?.(20, "Initializing OCR...");
        }
      },
    });
    ocrWorker = worker;
    loadedLang = lang;
  })();

  try {
    await ocrWorkerLoading;
  } catch (err) {
    ocrWorkerLoading = null;
    throw err;
  }
  return ocrWorker;
}

// ── PDF page-to-image helper ────────────────────────────────────────────────
async function pdfToImages(bytes: Uint8Array): Promise<HTMLCanvasElement[]> {
  const pdfjsLib = await import("pdfjs-dist");
  const pdfjsWorker = await import("pdfjs-dist/build/pdf.worker.mjs?url").catch(() => null);
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker?.default || "";
  const pdf = await pdfjsLib.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 2 }); // 2x for OCR quality
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    canvases.push(canvas);
  }
  return canvases;
}

export function initOcrTool() {
  const dropArea = document.getElementById("ocr-drop-area") as HTMLDivElement;
  const dropText = document.getElementById("ocr-drop-text") as HTMLSpanElement;
  const fileInput = document.getElementById("ocr-file-input") as HTMLInputElement;
  const langSelect = document.getElementById("ocr-lang") as HTMLSelectElement;
  const extractBtn = document.getElementById("ocr-extract-btn") as HTMLButtonElement;
  const progress = document.getElementById("ocr-progress") as HTMLDivElement;
  const progressFill = progress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const progressText = progress.querySelector(".speech-progress-text") as HTMLSpanElement;
  const output = document.getElementById("ocr-output") as HTMLDivElement;
  const resultArea = document.getElementById("ocr-result") as HTMLTextAreaElement;
  const copyBtn = document.getElementById("ocr-copy-btn") as HTMLButtonElement;
  const downloadBtn = document.getElementById("ocr-download-btn") as HTMLButtonElement;

  let selectedFile: File | null = null;
  let processing = false;

  function updateExtractBtn() {
    extractBtn.classList.toggle("disabled", !selectedFile || processing);
  }

  function setFile(file: File) {
    selectedFile = file;
    dropText.textContent = file.name;
    dropArea.classList.add("has-file");
    updateExtractBtn();
  }

  // File selection
  dropArea.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) setFile(fileInput.files[0]);
    fileInput.value = "";
  });

  // Drag and drop
  dropArea.addEventListener("dragover", (e) => { e.preventDefault(); dropArea.classList.add("drag-over"); });
  dropArea.addEventListener("dragleave", () => dropArea.classList.remove("drag-over"));
  dropArea.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.remove("drag-over");
    if (e.dataTransfer?.files?.[0]) setFile(e.dataTransfer.files[0]);
  });

  // Extract button
  extractBtn.addEventListener("click", async () => {
    if (!selectedFile || processing) return;
    processing = true;
    updateExtractBtn();
    progress.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressText.textContent = "Preparing...";
    output.classList.add("hidden");

    try {
      const lang = langSelect.value;
      const ext = selectedFile.name.split(".").pop()?.toLowerCase();
      const bytes = new Uint8Array(await selectedFile.arrayBuffer());

      let resultText = "";

      if (ext === "pdf") {
        progressText.textContent = "Rendering PDF pages...";
        progressFill.style.width = "5%";
        const canvases = await pdfToImages(bytes);

        const worker = await getOcrWorker(lang, (pct, msg) => {
          progressFill.style.width = `${Math.round(5 + pct * 0.15)}%`;
          progressText.textContent = msg;
        });

        const pageTexts: string[] = [];
        for (let i = 0; i < canvases.length; i++) {
          progressText.textContent = `OCR page ${i + 1}/${canvases.length}...`;
          progressFill.style.width = `${Math.round(20 + (i / canvases.length) * 75)}%`;
          const { data } = await worker.recognize(canvases[i]);
          pageTexts.push(data.text.trim());
        }
        resultText = pageTexts.join("\n\n---\n\n");
      } else {
        // Image file
        const worker = await getOcrWorker(lang, (pct, msg) => {
          progressFill.style.width = `${Math.round(pct * 0.9)}%`;
          progressText.textContent = msg;
        });

        progressText.textContent = "Recognizing text...";
        const { data } = await worker.recognize(selectedFile);
        resultText = data.text.trim();
      }

      progressFill.style.width = "100%";
      progressText.textContent = "Done!";
      resultArea.value = resultText;
      output.classList.remove("hidden");
      setTimeout(() => progress.classList.add("hidden"), 600);

    } catch (err: any) {
      console.error("[OCR] Error:", err);
      progressText.textContent = `Error: ${err?.message || "OCR failed."}`;
    } finally {
      processing = false;
      updateExtractBtn();
    }
  });

  // Copy
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(resultArea.value);
    const orig = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy`; }, 1500);
  });

  // Download
  downloadBtn.addEventListener("click", () => {
    const blob = new Blob([resultArea.value], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ocr-result.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ── Read Aloud (TTS) ─────────────────────────────────────────────────
  const readAloudBtn = document.getElementById("ocr-read-aloud-btn") as HTMLButtonElement;
  const ttsProgress = document.getElementById("ocr-tts-progress") as HTMLDivElement;
  const ttsProgressFill = ttsProgress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const ttsProgressText = ttsProgress.querySelector(".speech-progress-text") as HTMLSpanElement;
  const ttsFreezeWarn = ttsProgress.querySelector(".speech-freeze-warning") as HTMLParagraphElement;
  const ttsPlayer = document.getElementById("ocr-tts-player") as HTMLDivElement;
  const wordDisplay = document.getElementById("ocr-word-display") as HTMLDivElement;
  const ttsAudio = document.getElementById("ocr-tts-audio") as HTMLAudioElement;
  const playBtn = document.getElementById("ocr-play-btn") as HTMLButtonElement;
  const skipBack = document.getElementById("ocr-skip-back") as HTMLButtonElement;
  const skipForward = document.getElementById("ocr-skip-forward") as HTMLButtonElement;
  const seekBar = document.getElementById("ocr-seek-bar") as HTMLDivElement;
  const seekFill = document.getElementById("ocr-seek-fill") as HTMLDivElement;
  const seekThumb = document.getElementById("ocr-seek-thumb") as HTMLDivElement;
  const timeCurrent = document.getElementById("ocr-time-current") as HTMLSpanElement;
  const timeDuration = document.getElementById("ocr-time-duration") as HTMLSpanElement;

  const PLAY_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
  const PAUSE_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
  playBtn.innerHTML = PLAY_SVG;

  interface WordTiming { word: string; start: number; end: number; el: HTMLSpanElement; }
  let wordTimings: WordTiming[] = [];
  let activeWordIdx = -1;
  let ttsAudioUrl: string | null = null;
  let ttsGenerating = false;

  function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function buildWordSpans(text: string): HTMLSpanElement[] {
    wordDisplay.innerHTML = "";
    const tokens = text.split(/(\s+)/);
    const spans: HTMLSpanElement[] = [];
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) {
        wordDisplay.appendChild(document.createTextNode(tok));
      } else {
        const sp = document.createElement("span");
        sp.className = "speech-word";
        sp.textContent = tok;
        wordDisplay.appendChild(sp);
        spans.push(sp);
      }
    }
    return spans;
  }

  function buildTimings(chunks: Array<{ text: string; samples: number }>, sr: number, spans: HTMLSpanElement[]): WordTiming[] {
    const timings: WordTiming[] = [];
    let sOff = 0, sIdx = 0;
    for (const ch of chunks) {
      const tStart = sOff / sr, tEnd = (sOff + ch.samples) / sr;
      const words = ch.text.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) { sOff += ch.samples; continue; }
      const weights = words.map(spokenWeight);
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const chunkDur = tEnd - tStart;
      let t = tStart;
      for (let i = 0; i < words.length; i++) {
        const el = spans[sIdx]; if (!el) break;
        const dur = (weights[i] / totalWeight) * chunkDur;
        timings.push({ word: words[i], start: t, end: t + dur, el });
        t += dur;
        sIdx++;
      }
      sOff += ch.samples;
    }
    return timings;
  }

  function findWordAtTime(t: number): number {
    if (wordTimings.length === 0) return -1;
    let lo = 0, hi = wordTimings.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < wordTimings[mid].start) hi = mid - 1;
      else if (t >= wordTimings[mid].end) lo = mid + 1;
      else return mid;
    }
    if (t >= wordTimings[wordTimings.length - 1]?.start) return wordTimings.length - 1;
    return -1;
  }

  function updateHighlight() {
    const newIdx = findWordAtTime(ttsAudio.currentTime);
    if (newIdx !== activeWordIdx) {
      if (activeWordIdx >= 0 && activeWordIdx < wordTimings.length) wordTimings[activeWordIdx].el.classList.remove("active");
      if (newIdx >= 0) {
        wordTimings[newIdx].el.classList.add("active");
        const el = wordTimings[newIdx].el;
        if (el.offsetTop < wordDisplay.scrollTop || el.offsetTop + el.offsetHeight > wordDisplay.scrollTop + wordDisplay.clientHeight) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
      activeWordIdx = newIdx;
    }
  }

  let hlRaf = 0;
  function hlLoop() { updateHighlight(); hlRaf = requestAnimationFrame(hlLoop); }

  playBtn.addEventListener("click", () => { ttsAudio.paused ? ttsAudio.play() : ttsAudio.pause(); });
  ttsAudio.addEventListener("play", () => { playBtn.innerHTML = PAUSE_SVG; cancelAnimationFrame(hlRaf); hlLoop(); });
  ttsAudio.addEventListener("pause", () => { playBtn.innerHTML = PLAY_SVG; cancelAnimationFrame(hlRaf); });
  ttsAudio.addEventListener("ended", () => {
    playBtn.innerHTML = PLAY_SVG;
    cancelAnimationFrame(hlRaf);
    if (activeWordIdx >= 0 && activeWordIdx < wordTimings.length) wordTimings[activeWordIdx].el.classList.remove("active");
    activeWordIdx = -1;
  });
  skipBack.addEventListener("click", () => { ttsAudio.currentTime = Math.max(0, ttsAudio.currentTime - 10); });
  skipForward.addEventListener("click", () => { ttsAudio.currentTime = Math.min(ttsAudio.duration || 0, ttsAudio.currentTime + 10); });

  ttsAudio.addEventListener("timeupdate", () => {
    if (!ttsAudio.duration) return;
    const pct = (ttsAudio.currentTime / ttsAudio.duration) * 100;
    seekFill.style.width = `${pct}%`;
    seekThumb.style.left = `${pct}%`;
    timeCurrent.textContent = fmtTime(ttsAudio.currentTime);
    timeDuration.textContent = fmtTime(ttsAudio.duration);
  });
  ttsAudio.addEventListener("loadedmetadata", () => {
    timeCurrent.textContent = "0:00";
    timeDuration.textContent = fmtTime(ttsAudio.duration);
  });

  let ttsSeeking = false;
  function ttsSeekTo(e: MouseEvent | Touch) {
    const rect = seekBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (ttsAudio.duration) ttsAudio.currentTime = pct * ttsAudio.duration;
  }
  seekBar.addEventListener("mousedown", (e) => { ttsSeeking = true; ttsSeekTo(e); });
  window.addEventListener("mousemove", (e) => { if (ttsSeeking) ttsSeekTo(e); });
  window.addEventListener("mouseup", () => { ttsSeeking = false; });
  seekBar.addEventListener("touchstart", (e) => { ttsSeeking = true; ttsSeekTo(e.touches[0]); }, { passive: true });
  window.addEventListener("touchmove", (e) => { if (ttsSeeking) ttsSeekTo(e.touches[0]); }, { passive: true });
  window.addEventListener("touchend", () => { ttsSeeking = false; });

  readAloudBtn.addEventListener("click", async () => {
    const text = resultArea.value.trim();
    if (!text || ttsGenerating) return;

    ttsGenerating = true;
    readAloudBtn.classList.add("disabled");
    ttsProgress.classList.remove("hidden");
    ttsProgressFill.style.width = "0%";
    ttsProgressText.textContent = "Loading Kokoro TTS model...";
    ttsFreezeWarn.classList.add("hidden");
    ttsPlayer.classList.add("hidden");

    try {
      const tts = await getKokoro((pct, msg) => {
        ttsProgressFill.style.width = `${Math.round(pct * 0.6)}%`;
        ttsProgressText.textContent = msg;
      });

      ttsProgressText.textContent = "Generating speech...";
      ttsProgressFill.style.width = "65%";
      ttsFreezeWarn.classList.remove("hidden");

      const voice = (() => { try { return localStorage.getItem("convert-tts-voice") ?? "af_heart"; } catch { return "af_heart"; } })();
      const speed = (() => { try { return parseFloat(localStorage.getItem("convert-tts-speed") ?? "1"); } catch { return 1; } })();

      const wordSpans = buildWordSpans(text);
      const audioChunks: Float32Array[] = [];
      const chunkMeta: Array<{ text: string; samples: number }> = [];
      let sampleRate = 24000;

      const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
      const chunks: string[] = [];
      let cur = "";
      for (const s of sentences) {
        if (cur.length + s.length > 300 && cur) { chunks.push(cur.trim()); cur = s; }
        else cur += s;
      }
      if (cur.trim()) chunks.push(cur.trim());

      for (let i = 0; i < chunks.length; i++) {
        ttsProgressText.textContent = chunks.length > 1
          ? `Generating speech (${i + 1}/${chunks.length})...`
          : "Generating speech (this may take a moment)...";
        ttsProgressFill.style.width = `${Math.min(95, 65 + (i / chunks.length) * 30)}%`;

        const result = await tts.generate(chunks[i], { voice, speed });
        const data: Float32Array = result?.data ?? result?.audio;
        if (!data || !(data instanceof Float32Array) || data.length === 0) {
          throw new Error("TTS generated empty audio.");
        }
        sampleRate = result.sampling_rate || 24000;
        audioChunks.push(data);
        chunkMeta.push({ text: chunks[i], samples: data.length });
      }

      ttsProgressFill.style.width = "95%";
      ttsProgressText.textContent = "Encoding audio...";
      ttsFreezeWarn.classList.add("hidden");

      const total = audioChunks.reduce((s, c) => s + c.length, 0);
      const full = new Float32Array(total);
      let off = 0;
      for (const c of audioChunks) { full.set(c, off); off += c.length; }

      wordTimings = buildTimings(chunkMeta, sampleRate, wordSpans);
      activeWordIdx = -1;

      const wavBlob = encodeWav(full, sampleRate);
      if (ttsAudioUrl) URL.revokeObjectURL(ttsAudioUrl);
      ttsAudioUrl = URL.createObjectURL(wavBlob);
      ttsAudio.src = ttsAudioUrl;
      ttsAudio.load();

      ttsProgressFill.style.width = "100%";
      ttsProgressText.textContent = "Done!";
      ttsPlayer.classList.remove("hidden");
      setTimeout(() => { ttsProgress.classList.add("hidden"); }, 600);

    } catch (err: any) {
      console.error("[OCR TTS] Error:", err);
      ttsProgressText.textContent = `Error: ${err?.message || "Generation failed."}`;
      ttsFreezeWarn.classList.add("hidden");
    } finally {
      ttsGenerating = false;
      readAloudBtn.classList.remove("disabled");
    }
  });

  updateExtractBtn();
}

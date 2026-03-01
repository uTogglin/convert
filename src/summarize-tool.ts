import JSZip from "jszip";
import { getKokoro, encodeWav, spokenWeight } from "./speech-tool.js";

// ── Model options ───────────────────────────────────────────────────────────
const SUM_MODELS: Record<string, { id: string; label: string }> = {
  "distilbart-6-6":  { id: "Xenova/distilbart-cnn-6-6",  label: "DistilBART 6-6" },
  "distilbart-12-6": { id: "Xenova/distilbart-cnn-12-6", label: "DistilBART 12-6" },
  "bart-large-cnn":  { id: "Xenova/bart-large-cnn",      label: "BART Large CNN" },
};

function getSumModel(): string {
  try { return localStorage.getItem("convert-sum-model") ?? "distilbart-12-6"; } catch { return "distilbart-12-6"; }
}

// ── Lazy summarization pipeline ─────────────────────────────────────────────
let summarizer: any = null;
let summarizerLoading: Promise<any> | null = null;
let loadedModelKey: string | null = null;

async function getSummarizer(onProgress?: (pct: number, msg: string) => void): Promise<any> {
  const modelKey = getSumModel();

  // If model changed, discard old pipeline
  if (summarizer && loadedModelKey !== modelKey) {
    summarizer = null;
    summarizerLoading = null;
  }

  if (summarizer) return summarizer;
  if (summarizerLoading) { await summarizerLoading; return summarizer; }

  const modelInfo = SUM_MODELS[modelKey] || SUM_MODELS["distilbart-12-6"];

  summarizerLoading = (async () => {
    const { pipeline } = await import("@huggingface/transformers");

    // Use WebGPU when available, fall back to WASM
    const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator
      && await (navigator as any).gpu?.requestAdapter().catch(() => null);
    const device = hasWebGPU ? "webgpu" : "wasm";
    const dtype = hasWebGPU ? "fp32" : "q8";

    onProgress?.(0, `Loading ${modelInfo.label} (${device})...`);
    console.log(`[Summarize] Using device=${device}, dtype=${dtype}`);

    summarizer = await pipeline("summarization", modelInfo.id, {
      device,
      dtype,
      progress_callback: (info: any) => {
        if (info.status === "progress" && typeof info.progress === "number") {
          onProgress?.(Math.round(info.progress), `Downloading ${modelInfo.label} (${device})...`);
        }
      },
    } as any);

    loadedModelKey = modelKey;
    console.log(`[Summarize] ${modelInfo.label} loaded successfully (${device})`);
  })();

  try {
    await summarizerLoading;
  } catch (err) {
    summarizerLoading = null;
    throw err;
  }
  return summarizer;
}

// ── Text extraction ─────────────────────────────────────────────────────────
function extractTextFromTxt(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function extractTextFromHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Remove script/style tags
  for (const el of doc.querySelectorAll("script, style, noscript")) el.remove();
  return (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
}

async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjsLib.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it: any) => it.str).join(" "));
  }
  return parts.join("\n").replace(/\s+/g, " ").trim();
}

async function extractTextFromDocx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const docXml = await zip.file("word/document.xml")?.async("text");
  if (!docXml) throw new Error("Invalid DOCX: missing word/document.xml");
  const doc = new DOMParser().parseFromString(docXml, "application/xml");
  const textNodes = doc.getElementsByTagName("w:t");
  const parts: string[] = [];
  for (let i = 0; i < textNodes.length; i++) {
    parts.push(textNodes[i].textContent || "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Whether CORS proxy is enabled (opt-in, breaks full privacy) */
let corsProxyEnabled: boolean = (() => {
  try { return localStorage.getItem("convert-sum-cors-proxy") === "true"; } catch { return false; }
})();
window.addEventListener("sum-cors-proxy-change", ((e: CustomEvent) => {
  corsProxyEnabled = !!e.detail;
}) as EventListener);

async function fetchUrlText(url: string): Promise<string> {
  // Try direct fetch first
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    const text = extractTextFromHtml(html);
    if (text) return text;
  } catch {
    // Direct fetch blocked by CORS
  }

  // Fall back to CORS proxies only if user opted in
  if (corsProxyEnabled) {
    const proxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ];
    for (const proxyUrl of proxies) {
      try {
        const resp = await fetch(proxyUrl);
        if (!resp.ok) continue;
        const html = await resp.text();
        const text = extractTextFromHtml(html);
        if (text) return text;
      } catch { continue; }
    }
  }

  throw new Error(
    corsProxyEnabled
      ? "Could not fetch URL — all methods failed. The site may block external access."
      : "Blocked by CORS. Enable \"CORS proxy\" in Summarize settings to fetch cross-origin URLs (routes through a third-party server)."
  );
}

// ── Chunked summarization ───────────────────────────────────────────────────
function chunkText(text: string, maxWords: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(" "));
  }
  return chunks;
}

async function summarizeText(
  text: string,
  wordLimit: number,
  onProgress?: (pct: number, msg: string) => void,
): Promise<string> {
  const pipe = await getSummarizer(onProgress);

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= wordLimit) return text; // Already short enough

  const maxTokens = Math.round(wordLimit * 1.3);
  const minTokens = Math.round(wordLimit * 0.4);

  // For long docs, chunk and summarize each part
  if (words.length > 1200) {
    const chunks = chunkText(text, 1000);
    const partials: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(Math.round(((i + 1) / (chunks.length + 1)) * 100), `Summarizing chunk ${i + 1}/${chunks.length}...`);
      const result = await pipe(chunks[i], { max_length: maxTokens, min_length: Math.min(minTokens, 30) });
      partials.push(result[0].summary_text);
    }
    // If combined partials are still long, do a final pass
    const combined = partials.join(" ");
    if (combined.split(/\s+/).length > wordLimit * 1.5) {
      onProgress?.(95, "Final summarization pass...");
      const final = await pipe(combined, { max_length: maxTokens, min_length: minTokens });
      return final[0].summary_text;
    }
    return combined;
  }

  onProgress?.(80, "Summarizing...");
  const result = await pipe(text, { max_length: maxTokens, min_length: minTokens });
  return result[0].summary_text;
}

// ── Init ────────────────────────────────────────────────────────────────────
export function initSummarizeTool() {
  // DOM refs
  const tabs = document.querySelectorAll<HTMLButtonElement>(".sum-tab");
  const uploadPanel = document.getElementById("sum-upload-panel") as HTMLDivElement;
  const textPanel = document.getElementById("sum-text-panel") as HTMLDivElement;
  const urlPanel = document.getElementById("sum-url-panel") as HTMLDivElement;

  const fileDrop = document.getElementById("sum-file-drop") as HTMLDivElement;
  const fileInput = document.getElementById("sum-file-input") as HTMLInputElement;
  const fileName = document.getElementById("sum-file-name") as HTMLSpanElement;
  const textInput = document.getElementById("sum-text-input") as HTMLTextAreaElement;
  const urlInput = document.getElementById("sum-url-input") as HTMLInputElement;
  const fetchBtn = document.getElementById("sum-fetch-btn") as HTMLButtonElement;
  const wordLimitInput = document.getElementById("sum-word-limit") as HTMLInputElement;
  const textWordLimitInput = document.querySelector(".sum-text-word-limit") as HTMLInputElement;
  const urlWordLimitInput = document.querySelector(".sum-url-word-limit") as HTMLInputElement;
  const summarizeBtn = document.getElementById("sum-summarize-btn") as HTMLButtonElement;
  const textSummarizeBtn = document.querySelector(".sum-text-summarize-btn") as HTMLButtonElement;
  const urlSummarizeBtn = document.querySelector(".sum-url-summarize-btn") as HTMLButtonElement;

  const progress = document.getElementById("sum-progress") as HTMLDivElement;
  const progressFill = progress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const progressText = progress.querySelector(".speech-progress-text") as HTMLSpanElement;

  const output = document.getElementById("sum-output") as HTMLDivElement;
  const resultArea = document.getElementById("sum-result") as HTMLTextAreaElement;
  const copyBtn = document.getElementById("sum-copy-btn") as HTMLButtonElement;
  const downloadBtn = document.getElementById("sum-download-btn") as HTMLButtonElement;

  let currentFile: File | null = null;
  let extractedText = "";
  let activeTab: "upload" | "text" | "url" = "upload";

  // Restore word limit from settings
  try {
    const saved = localStorage.getItem("convert-sum-word-limit");
    if (saved) {
      wordLimitInput.value = saved;
      if (textWordLimitInput) textWordLimitInput.value = saved;
      if (urlWordLimitInput) urlWordLimitInput.value = saved;
    }
  } catch {}

  // ── Tab switching ──────────────────────────────────────────────────────
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab as "upload" | "text" | "url";
      activeTab = target;
      extractedText = "";
      tabs.forEach(t => t.classList.toggle("active", t === tab));
      uploadPanel.classList.toggle("active", target === "upload");
      textPanel.classList.toggle("active", target === "text");
      urlPanel.classList.toggle("active", target === "url");
      updateSummarizeBtn();
    });
  }

  // ── File handling ──────────────────────────────────────────────────────
  fileDrop.addEventListener("click", () => fileInput.click());
  fileDrop.addEventListener("dragover", e => { e.preventDefault(); fileDrop.classList.add("dragover"); });
  fileDrop.addEventListener("dragleave", () => fileDrop.classList.remove("dragover"));
  fileDrop.addEventListener("drop", e => {
    e.preventDefault();
    fileDrop.classList.remove("dragover");
    if (e.dataTransfer?.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
  });

  function handleFile(file: File) {
    currentFile = file;
    fileName.textContent = file.name;
    extractedText = "";
    output.classList.add("hidden");
    updateSummarizeBtn();
  }

  // ── Text input handling ─────────────────────────────────────────────────
  textInput.addEventListener("input", updateSummarizeBtn);
  textSummarizeBtn?.addEventListener("click", () => {
    if (textSummarizeBtn.classList.contains("disabled")) return;
    doSummarize();
  });

  // ── URL handling ───────────────────────────────────────────────────────
  urlInput.addEventListener("input", updateSummarizeBtn);
  fetchBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    try {
      fetchBtn.disabled = true;
      fetchBtn.textContent = "Fetching...";
      extractedText = await fetchUrlText(url);
      if (!extractedText) throw new Error("No text content found at URL");
      updateSummarizeBtn();
    } catch (err: any) {
      const msg = err?.message?.includes("Failed to fetch")
        ? "Could not fetch URL. This is likely blocked by CORS — the target site does not allow cross-origin requests from browsers."
        : err?.message || "Failed to fetch URL";
      alert(msg);
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = "Fetch";
    }
  });

  // URL panel summarize button
  urlSummarizeBtn?.addEventListener("click", () => doSummarize());

  // ── Summarize button state ─────────────────────────────────────────────
  function updateSummarizeBtn() {
    const uploadReady = !!currentFile;
    const textReady = !!textInput.value.trim();
    const urlReady = !!urlInput.value.trim();
    summarizeBtn.classList.toggle("disabled", !uploadReady);
    textSummarizeBtn?.classList.toggle("disabled", !textReady);
    urlSummarizeBtn?.classList.toggle("disabled", !urlReady);
  }

  // ── Progress helpers ───────────────────────────────────────────────────
  function showProgress(pct: number, msg: string) {
    progress.classList.remove("hidden");
    progressFill.style.width = `${pct}%`;
    progressText.textContent = msg;
  }

  function hideProgress() {
    progress.classList.add("hidden");
    progressFill.style.width = "0%";
  }

  // ── Extract text from file ─────────────────────────────────────────────
  async function extractFromFile(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = file.name.split(".").pop()?.toLowerCase() || "";

    if (["txt", "md", "csv", "json", "xml", "log", "yaml", "yml", "toml", "ini", "cfg", "conf"].includes(ext)) {
      return extractTextFromTxt(bytes);
    }
    if (ext === "html" || ext === "htm") {
      return extractTextFromHtml(new TextDecoder().decode(bytes));
    }
    if (ext === "pdf") {
      return extractTextFromPdf(bytes);
    }
    if (ext === "docx") {
      return extractTextFromDocx(bytes);
    }
    throw new Error(`Unsupported file type: .${ext}`);
  }

  // ── Summarize handler ──────────────────────────────────────────────────
  async function doSummarize() {
    const wlInput = activeTab === "url" ? urlWordLimitInput : activeTab === "text" ? textWordLimitInput : wordLimitInput;
    const wordLimit = Math.max(50, Math.min(500, parseInt(wlInput?.value || wordLimitInput.value) || 150));
    output.classList.add("hidden");

    try {
      // Extract text if needed
      if (!extractedText) {
        if (activeTab === "upload" && currentFile) {
          showProgress(10, "Extracting text...");
          extractedText = await extractFromFile(currentFile);
        } else if (activeTab === "text") {
          extractedText = textInput.value.trim();
        } else if (activeTab === "url") {
          showProgress(10, "Fetching URL...");
          extractedText = await fetchUrlText(urlInput.value.trim());
        }
      }

      if (!extractedText || extractedText.trim().length < 20) {
        alert("Not enough text content to summarize.");
        hideProgress();
        return;
      }

      showProgress(20, "Loading AI model...");

      const summary = await summarizeText(extractedText, wordLimit, (pct, msg) => {
        showProgress(20 + Math.round(pct * 0.8), msg);
      });

      resultArea.value = summary;
      output.classList.remove("hidden");
      showProgress(100, "Done!");
      setTimeout(hideProgress, 1500);
    } catch (err: any) {
      console.error("[Summarize] Error:", err);
      alert(err?.message || "Summarization failed");
      hideProgress();
    }
  }

  summarizeBtn.addEventListener("click", () => {
    if (summarizeBtn.classList.contains("disabled")) return;
    doSummarize();
  });

  // ── Copy + download ────────────────────────────────────────────────────
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(resultArea.value);
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy`; }, 1500);
    } catch { /* clipboard not available */ }
  });

  downloadBtn.addEventListener("click", () => {
    const blob = new Blob([resultArea.value], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "summary.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ── Read Aloud (TTS) ─────────────────────────────────────────────────
  const readAloudBtn = document.getElementById("sum-read-aloud-btn") as HTMLButtonElement;
  const ttsProgress = document.getElementById("sum-tts-progress") as HTMLDivElement;
  const ttsProgressFill = ttsProgress.querySelector(".speech-progress-fill") as HTMLDivElement;
  const ttsProgressText = ttsProgress.querySelector(".speech-progress-text") as HTMLSpanElement;
  const ttsFreezeWarn = ttsProgress.querySelector(".speech-freeze-warning") as HTMLParagraphElement;
  const ttsPlayer = document.getElementById("sum-tts-player") as HTMLDivElement;
  const wordDisplay = document.getElementById("sum-word-display") as HTMLDivElement;
  const ttsAudio = document.getElementById("sum-tts-audio") as HTMLAudioElement;
  const playBtn = document.getElementById("sum-play-btn") as HTMLButtonElement;
  const skipBack = document.getElementById("sum-skip-back") as HTMLButtonElement;
  const skipForward = document.getElementById("sum-skip-forward") as HTMLButtonElement;
  const seekBar = document.getElementById("sum-seek-bar") as HTMLDivElement;
  const seekFill = document.getElementById("sum-seek-fill") as HTMLDivElement;
  const seekThumb = document.getElementById("sum-seek-thumb") as HTMLDivElement;
  const timeCurrent = document.getElementById("sum-time-current") as HTMLSpanElement;
  const timeDuration = document.getElementById("sum-time-duration") as HTMLSpanElement;

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
      // Weight each word's duration by estimated spoken length
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

  // 60fps highlight loop
  let hlRaf = 0;
  function hlLoop() { updateHighlight(); hlRaf = requestAnimationFrame(hlLoop); }

  // Playback controls
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

  // Seek
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

  // Read Aloud button
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

      // Split into sentence-sized chunks
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

      // Concatenate
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
      console.error("[Summarize TTS] Error:", err);
      ttsProgressText.textContent = `Error: ${err?.message || "Generation failed."}`;
      ttsFreezeWarn.classList.add("hidden");
    } finally {
      ttsGenerating = false;
      readAloudBtn.classList.remove("disabled");
    }
  });

  updateSummarizeBtn();
}

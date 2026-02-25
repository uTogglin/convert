import type { FileFormat, FileData, FormatHandler, ConvertPathNode } from "./FormatHandler.js";
import normalizeMimeType from "./normalizeMimeType.js";
import handlers from "./handlers";
import { TraversionGraph } from "./TraversionGraph.js";
import JSZip from "jszip";
import { gzip as pakoGzip } from "pako";
import { createTar } from "./handlers/archive.js";
import { applyFileCompression } from "./compress.js";

// ── In-app console log capture ─────────────────────────────────────────────
interface AppLogEntry { level: "error" | "warn" | "info"; msg: string; time: string; }
const appLogBuffer: AppLogEntry[] = [];

function _fmtArg(a: unknown): string {
  if (a instanceof Error) return `${a.message}${a.stack ? "\n" + a.stack : ""}`;
  if (typeof a === "object" && a !== null) { try { return JSON.stringify(a, null, 2); } catch { return String(a); } }
  return String(a);
}

function _appendAppLog(level: AppLogEntry["level"], args: unknown[]) {
  const msg = args.map(_fmtArg).join(" ");
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => n.toString().padStart(2, "0")).join(":");
  appLogBuffer.push({ level, msg, time });
  const badge = document.getElementById("log-badge");
  if (badge) {
    const count = appLogBuffer.filter(e => e.level === "error").length;
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count === 0);
  }
  const list = document.getElementById("app-log-list");
  if (list) _renderAppLogInto(list);
}

function _renderAppLogInto(list: HTMLElement) {
  list.innerHTML = "";
  if (appLogBuffer.length === 0) {
    const empty = document.createElement("p");
    empty.className = "app-log-empty";
    empty.textContent = "No activity logged yet.";
    list.appendChild(empty);
    return;
  }
  for (const entry of [...appLogBuffer].reverse()) {
    const row = document.createElement("div");
    row.className = `app-log-row app-log-${entry.level}`;
    const time = document.createElement("span"); time.className = "app-log-time"; time.textContent = entry.time;
    const lbl  = document.createElement("span"); lbl.className  = "app-log-level"; lbl.textContent = entry.level.toUpperCase();
    const msgEl = document.createElement("span"); msgEl.className = "app-log-msg"; msgEl.textContent = entry.msg;
    row.append(time, lbl, msgEl);
    list.appendChild(row);
  }
}

const _origConsoleError = console.error.bind(console);
const _origConsoleWarn  = console.warn.bind(console);
console.error = (...args: unknown[]) => { _origConsoleError(...args); _appendAppLog("error", args); };
console.warn  = (...args: unknown[]) => { _origConsoleWarn(...args);  _appendAppLog("warn",  args); };
// ──────────────────────────────────────────────────────────────────────────────

/** Files currently selected for conversion */
let selectedFiles: File[] = [];
/**
 * Whether to use "simple" mode.
 * - In **simple** mode, the input/output lists are grouped by file format.
 * - In **advanced** mode, these lists are grouped by format handlers, which
 *   requires the user to manually select the tool that processes the output.
 */
let simpleMode: boolean = true;

/** Auto-download: when true, files download immediately; when false, only appear in output tray */
let autoDownload: boolean = (() => {
  try { return localStorage.getItem("convert-auto-download") !== "false"; } catch { return true; }
})();

/** Archive multi-file output: when true, multiple converted files are zipped; when false, downloaded separately */
let archiveMultiOutput: boolean = (() => {
  try { return localStorage.getItem("convert-archive-multi") !== "false"; } catch { return true; }
})();

/** Remove background: when true, image outputs have their background removed */
let removeBg: boolean = (() => {
  try { return localStorage.getItem("convert-remove-bg") === "true"; } catch { return false; }
})();

/** Background removal mode: "local" uses RMBG-1.4, "api" uses remove.bg */
let bgMode: "local" | "api" = (() => {
  try { return localStorage.getItem("convert-bg-mode") === "api" ? "api" : "local"; } catch { return "local" as const; }
})();

/** remove.bg API key */
let bgApiKey: string = (() => {
  try { return localStorage.getItem("convert-bg-api-key") ?? ""; } catch { return ""; }
})();

/** Correction: when true, preserves text/graphics during background removal */
let bgCorrection: boolean = (() => {
  try { return localStorage.getItem("convert-bg-correction") === "true"; } catch { return false; }
})();

/** Image rescaling settings */
let rescaleEnabled: boolean = (() => {
  try { return localStorage.getItem("convert-rescale") === "true"; } catch { return false; }
})();
let rescaleWidth: number = (() => {
  try { return parseInt(localStorage.getItem("convert-rescale-width") ?? "0") || 0; } catch { return 0; }
})();
let rescaleHeight: number = (() => {
  try { return parseInt(localStorage.getItem("convert-rescale-height") ?? "0") || 0; } catch { return 0; }
})();
let rescaleLockRatio: boolean = (() => {
  try { return localStorage.getItem("convert-rescale-lock") !== "false"; } catch { return true; }
})();

/** Privacy mode: strips metadata and randomizes filenames for API calls */
let privacyMode: boolean = (() => {
  try { return localStorage.getItem("convert-privacy") === "true"; } catch { return false; }
})();

/** Compression: compress output files to fit a target size or re-encode for quality */
let compressEnabled: boolean = (() => {
  try { return localStorage.getItem("convert-compress") === "true"; } catch { return false; }
})();
let compressTargetMB: number = (() => {
  try { return parseFloat(localStorage.getItem("convert-compress-target") ?? "0") || 0; } catch { return 0; }
})();
let compressMode: "auto" | "lossy" = (() => {
  try { return localStorage.getItem("convert-compress-mode") === "lossy" ? "lossy" : "auto"; } catch { return "auto" as const; }
})();
let compressType: "target" | "reencode" = (() => {
  try { return localStorage.getItem("convert-compress-type") === "reencode" ? "reencode" : "target"; } catch { return "target" as const; }
})();
let encoderSpeed: "fast" | "balanced" | "quality" = (() => {
  try {
    const v = localStorage.getItem("convert-encoder-speed");
    return v === "fast" || v === "quality" ? v : "balanced";
  } catch { return "balanced" as const; }
})();
let reencodeCrf: number = (() => {
  try { return parseInt(localStorage.getItem("convert-reencode-crf") ?? "23") || 23; } catch { return 23; }
})();

/** Queue for mixed-category batch conversion */
let conversionQueue: File[][] = [];
let currentQueueIndex = 0;
/** True when all uploaded files share the same media category */
let isSameCategoryBatch = false;
/** All files from the original upload (before queue splitting) */
let allUploadedFiles: File[] = [];

/** Name of the folder picked via "Open Folder", or null if files were added individually */
let activeFolderName: string | null = null;

/** Returns the broad media category from a file's MIME type */
function getMediaCategory(file: File): string {
  return file.type.split("/")[0] || "unknown";
}

/** Finds the matching allOptions entry for a file */
function findInputOption(file: File): { format: FileFormat; handler: FormatHandler } | null {
  const mime = normalizeMimeType(file.type);
  const ext = file.name.split(".").pop()?.toLowerCase();
  const matches = allOptions.filter(o => o.format.from && o.format.mime === mime);
  if (matches.length === 0) {
    // Fall back to extension match
    return allOptions.find(o => o.format.from && o.format.extension?.toLowerCase() === ext) || null;
  }
  if (matches.length > 1 && ext) {
    const extMatch = matches.find(o => o.format.extension?.toLowerCase() === ext);
    if (extMatch) return extMatch;
  }
  return matches[0];
}

/** Handlers that support conversion from any formats. */
const conversionsFromAnyInput: ConvertPathNode[] = handlers
.filter(h => h.supportAnyInput && h.supportedFormats)
.flatMap(h => h.supportedFormats!
  .filter(f => f.to)
  .map(f => ({ handler: h, format: f})))

const ui = {
  fileInput: document.querySelector("#file-input") as HTMLInputElement,
  fileSelectArea: document.querySelector("#file-area") as HTMLDivElement,
  convertButton: document.querySelector("#convert-button") as HTMLButtonElement,
  modeToggleButton: document.querySelector("#mode-button") as HTMLButtonElement,
  inputList: document.querySelector("#from-list") as HTMLDivElement,
  outputList: document.querySelector("#to-list") as HTMLDivElement,
  inputSearch: document.querySelector("#search-from") as HTMLInputElement,
  outputSearch: document.querySelector("#search-to") as HTMLInputElement,
  popupBox: document.querySelector("#popup") as HTMLDivElement,
  popupBackground: document.querySelector("#popup-bg") as HTMLDivElement,
  archivePanel: document.querySelector("#archive-panel") as HTMLDivElement,
  archiveFmtBtns: document.querySelectorAll(".archive-fmt-btn") as NodeListOf<HTMLButtonElement>,
  createArchiveBtn: document.querySelector("#create-archive-btn") as HTMLButtonElement,
  themeToggle: document.querySelector("#theme-toggle") as HTMLButtonElement,
  settingsToggle: document.querySelector("#settings-toggle") as HTMLButtonElement,
  settingsDrawer: document.querySelector("#settings-drawer") as HTMLDivElement,
  accentColors: document.querySelectorAll(".color-dot") as NodeListOf<HTMLButtonElement>,
  customAccent: document.querySelector("#custom-accent") as HTMLInputElement,
  autoDownloadToggle: document.querySelector("#auto-download-toggle") as HTMLButtonElement,
  archiveMultiToggle: document.querySelector("#archive-multi-toggle") as HTMLButtonElement,
  removeBgToggle: document.querySelector("#remove-bg-toggle") as HTMLButtonElement,
  bgModeToggle: document.querySelector("#bg-mode-toggle") as HTMLButtonElement,
  bgCorrectionToggle: document.querySelector("#bg-correction-toggle") as HTMLButtonElement,
  bgApiKeyRow: document.querySelector("#bg-api-key-row") as HTMLDivElement,
  bgApiKeyInput: document.querySelector("#bg-api-key") as HTMLInputElement,
  rescaleToggle: document.querySelector("#rescale-toggle") as HTMLButtonElement,
  rescaleOptions: document.querySelector("#rescale-options") as HTMLDivElement,
  rescaleWidthInput: document.querySelector("#rescale-width") as HTMLInputElement,
  rescaleHeightInput: document.querySelector("#rescale-height") as HTMLInputElement,
  rescaleLockInput: document.querySelector("#rescale-lock-ratio") as HTMLInputElement,
  privacyToggle: document.querySelector("#privacy-toggle") as HTMLButtonElement,
  compressToggle: document.querySelector("#compress-toggle") as HTMLButtonElement,
  compressOptions: document.querySelector("#compress-options") as HTMLDivElement,
  compressTargetInput: document.querySelector("#compress-target-mb") as HTMLInputElement,
  compressPresetBtns: document.querySelectorAll(".compress-preset-btn") as NodeListOf<HTMLButtonElement>,
  compressTypeBtns: document.querySelectorAll(".compress-type-btn") as NodeListOf<HTMLButtonElement>,
  compressTargetOptions: document.querySelector("#compress-target-options") as HTMLDivElement,
  compressReencodeOptions: document.querySelector("#compress-reencode-options") as HTMLDivElement,
  crfPresetBtns: document.querySelectorAll(".crf-preset-btn") as NodeListOf<HTMLButtonElement>,
  crfSlider: document.querySelector("#crf-slider") as HTMLInputElement,
  crfValue: document.querySelector("#crf-value") as HTMLSpanElement,
  encoderPresetBtns: document.querySelectorAll(".encoder-preset-btn") as NodeListOf<HTMLButtonElement>,
  outputTray: document.querySelector("#output-tray") as HTMLDivElement,
  outputTrayGrid: document.querySelector("#output-tray-grid") as HTMLDivElement,
  downloadAllBtn: document.querySelector("#download-all-btn") as HTMLButtonElement,
  clearOutputBtn: document.querySelector("#clear-output-btn") as HTMLButtonElement,
};

/** Active category filter for input and output lists */
let inputCategoryFilter = "all";
let outputCategoryFilter = "all";

/** Maps a format's category field to a filter group */
function getCategoryGroup(cat: string | string[] | undefined): string {
  const cats = Array.isArray(cat) ? cat : cat ? [cat] : [];
  for (const c of cats) {
    const lc = c.toLowerCase();
    if (lc === "image" || lc === "vector") return "image";
    if (lc === "video") return "video";
    if (lc === "data" || lc === "text") return "code";
  }
  if (cats.length === 0) return "other";
  return "other";
}

/** Applies both text search and category filter to a format list */
function applyCombinedFilter(list: HTMLDivElement, isInput: boolean) {
  const searchStr = (isInput ? ui.inputSearch : ui.outputSearch).value.toLowerCase();
  const activeCat = isInput ? inputCategoryFilter : outputCategoryFilter;

  for (const button of Array.from(list.children)) {
    if (!(button instanceof HTMLButtonElement)) continue;
    const formatIndex = button.getAttribute("format-index");

    // Text match
    let textMatch = true;
    if (searchStr) {
      let hasExtension = false;
      if (formatIndex) {
        const format = allOptions[parseInt(formatIndex)];
        hasExtension = format?.format.extension.toLowerCase().includes(searchStr);
      }
      const hasText = button.textContent!.toLowerCase().includes(searchStr);
      textMatch = hasExtension || hasText;
    }

    // Category match
    let catMatch = true;
    if (activeCat !== "all" && formatIndex) {
      const opt = allOptions[parseInt(formatIndex)];
      catMatch = getCategoryGroup(opt?.format.category) === activeCat;
    }

    button.style.display = (textMatch && catMatch) ? "" : "none";
  }
}

/**
 * Filters a list of butttons to exclude those not matching a substring.
 * @param list Button list (div) to filter.
 * @param string Substring for which to search.
 */
const filterButtonList = (list: HTMLDivElement, _string: string) => {
  const isInput = list === ui.inputList;
  applyCombinedFilter(list, isInput);
}

/**
 * Handles search box input by filtering its parent container.
 * @param event Input event from an {@link HTMLInputElement}
 */
const searchHandler = (event: Event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  const targetParentList = target.parentElement?.querySelector(".format-list");
  if (!(targetParentList instanceof HTMLDivElement)) return;

  const isInput = targetParentList === ui.inputList;
  applyCombinedFilter(targetParentList, isInput);
};

// Assign search handler to both search boxes
ui.inputSearch.oninput = searchHandler;
ui.outputSearch.oninput = searchHandler;

// Map clicks in the file selection area to the file input element
ui.fileSelectArea.onclick = () => {
  ui.fileInput.click();
};

/** Reset UI back to the initial upload prompt state */
function resetToUploadPrompt() {
  selectedFiles = [];
  allUploadedFiles = [];
  conversionQueue = [];
  currentQueueIndex = 0;
  ui.fileSelectArea.classList.remove("has-file");
  ui.fileSelectArea.innerHTML = `
    <h2>Drop files here</h2>
    <p><span id="drop-hint-text">or </span>click to browse</p>
    <button class="browse-btn" onclick="document.getElementById('file-input').click(); event.stopPropagation();">Browse files</button>
  `;
  activeFolderName = null;
  ui.archivePanel.classList.remove("visible");
  appendFolderButton();
  // Clear format selections
  const prevInput = ui.inputList.querySelector(".selected");
  if (prevInput) prevInput.className = "";
  const prevOutput = ui.outputList.querySelector(".selected");
  if (prevOutput) prevOutput.className = "";
  ui.convertButton.className = "disabled";
  ui.convertButton.textContent = "Convert";
  ui.convertButton.removeAttribute("data-process-mode");
  ui.inputSearch.value = "";
  ui.outputSearch.value = "";
  inputCategoryFilter = "all";
  outputCategoryFilter = "all";
  // Reset active states on category pills
  for (const btn of Array.from(document.querySelectorAll(".category-filter-btn"))) {
    btn.classList.toggle("active", btn.textContent === "All");
  }
  filterButtonList(ui.inputList, "");
  filterButtonList(ui.outputList, "");
}

/**
 * Renders thumbnail previews for all selected files inside the upload card.
 * Images show a real thumbnail; other file types show an extension badge.
 */
const renderFilePreviews = (files: File[]) => {
  ui.fileSelectArea.classList.add("has-file");
  ui.fileSelectArea.innerHTML = "";

  const header = document.createElement("div");
  header.className = "file-preview-header";

  const countLabel = document.createElement("span");
  if (conversionQueue.length > 1) {
    countLabel.textContent = `Group ${currentQueueIndex + 1} of ${conversionQueue.length} — ${files.length} file${files.length !== 1 ? "s" : ""}`;
  } else {
    countLabel.textContent = files.length === 1
      ? "1 file selected"
      : `${files.length} files selected`;
  }

  const addMoreBtn = document.createElement("button");
  addMoreBtn.className = "browse-btn";
  addMoreBtn.textContent = "+ Add more";
  addMoreBtn.onclick = (e) => {
    e.stopPropagation();
    ui.fileInput.click();
  };

  header.appendChild(countLabel);
  header.appendChild(addMoreBtn);
  ui.fileSelectArea.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "file-preview-grid";

  for (const file of files) {
    const item = document.createElement("div");
    item.className = "file-preview-item";

    const thumb = document.createElement("div");
    thumb.className = "file-preview-thumb";

    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      const url = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(url);
      img.src = url;
      img.alt = file.name;
      thumb.appendChild(img);
    } else {
      const badge = document.createElement("div");
      badge.className = "file-ext-badge";
      badge.textContent = file.name.split(".").pop()?.toUpperCase() ?? "?";
      thumb.appendChild(badge);
    }

    const nameEl = document.createElement("div");
    nameEl.className = "file-preview-name";
    nameEl.textContent = file.name;
    nameEl.title = file.name;

    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.className = "file-remove-btn";
    removeBtn.textContent = "\u00D7";
    removeBtn.title = "Remove file";
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      const idx = selectedFiles.indexOf(file);
      if (idx !== -1) selectedFiles.splice(idx, 1);
      const allIdx = allUploadedFiles.indexOf(file);
      if (allIdx !== -1) allUploadedFiles.splice(allIdx, 1);

      // Also update conversionQueue if active
      if (conversionQueue.length > 1) {
        conversionQueue[currentQueueIndex] = selectedFiles;
        if (selectedFiles.length === 0) {
          conversionQueue.splice(currentQueueIndex, 1);
          if (conversionQueue.length === 0) {
            resetToUploadPrompt();
            return;
          }
          if (currentQueueIndex >= conversionQueue.length) currentQueueIndex = conversionQueue.length - 1;
          presentQueueGroup(currentQueueIndex);
          return;
        }
      }

      if (selectedFiles.length === 0) {
        resetToUploadPrompt();
      } else {
        renderFilePreviews(selectedFiles);
        autoSelectInputFormat(selectedFiles[0]);
      }
    };

    item.appendChild(removeBtn);
    item.appendChild(thumb);
    item.appendChild(nameEl);
    grid.appendChild(item);
  }

  ui.fileSelectArea.appendChild(grid);
  ui.archivePanel.classList.add("visible");

  // Show folder indicator when in folder mode
  if (activeFolderName) {
    const indicator = document.createElement("div");
    indicator.className = "folder-indicator";
    indicator.innerHTML = `&#128193; <strong>${activeFolderName}</strong> &mdash; ${allUploadedFiles.length} file${allUploadedFiles.length !== 1 ? "s" : ""}`;
    header.insertBefore(indicator, header.firstChild);
  }
};

/**
 * Validates and stores user selected files. Works for both manual
 * selection and file drag-and-drop.
 * @param event Either a file input element's "change" event,
 * or a "drop" event.
 */
const fileSelectHandler = (event: Event) => {

  let inputFiles;

  if (event instanceof DragEvent) {
    inputFiles = event.dataTransfer?.files;
    if (inputFiles) event.preventDefault();
  } else if (event instanceof ClipboardEvent) {
    inputFiles = event.clipboardData?.files;
  } else {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    inputFiles = target.files;
  }

  if (!inputFiles) return;
  const newFiles = Array.from(inputFiles);
  if (newFiles.length === 0) return;

  // Append to existing files if any, deduplicating by name+size
  const existing = new Set(allUploadedFiles.map(f => `${f.name}|${f.size}`));
  const merged = [...allUploadedFiles, ...newFiles.filter(f => !existing.has(`${f.name}|${f.size}`))];
  merged.sort((a, b) => a.name === b.name ? 0 : (a.name < b.name ? -1 : 1));
  const files = merged;
  allUploadedFiles = files;

  // Determine if all files share the same media category
  const categories = new Set(files.map(f => getMediaCategory(f)));
  isSameCategoryBatch = categories.size === 1;

  if (isSameCategoryBatch) {
    // Same category: show all files, auto-select input format from first file
    conversionQueue = [];
    currentQueueIndex = 0;
    selectedFiles = files;
    renderFilePreviews(files);
    autoSelectInputFormat(files[0]);
  } else {
    // Mixed categories: group by media category and start queue
    const groupMap = new Map<string, File[]>();
    for (const file of files) {
      const cat = getMediaCategory(file);
      if (!groupMap.has(cat)) groupMap.set(cat, []);
      groupMap.get(cat)!.push(file);
    }
    conversionQueue = Array.from(groupMap.values());
    currentQueueIndex = 0;
    presentQueueGroup(currentQueueIndex);
  }
  updateProcessButton();

  // Reset file input so re-selecting the same file triggers change
  ui.fileInput.value = "";
};

/** Auto-select the input format button for a given file */
function autoSelectInputFormat(file: File) {
  const mimeType = normalizeMimeType(file.type);
  const fileExtension = file.name.split(".").pop()?.toLowerCase();

  const buttonsMatchingMime = Array.from(ui.inputList.children).filter(button => {
    if (!(button instanceof HTMLButtonElement)) return false;
    return button.getAttribute("mime-type") === mimeType;
  }) as HTMLButtonElement[];

  let inputFormatButton: HTMLButtonElement;
  if (buttonsMatchingMime.length > 1) {
    inputFormatButton = buttonsMatchingMime.find(button => {
      const formatIndex = button.getAttribute("format-index");
      if (!formatIndex) return;
      const format = allOptions[parseInt(formatIndex)];
      return format.format.extension === fileExtension;
    }) || buttonsMatchingMime[0];
  } else {
    inputFormatButton = buttonsMatchingMime[0];
  }

  if (mimeType && inputFormatButton instanceof HTMLButtonElement) {
    inputFormatButton.click();
    ui.inputSearch.value = mimeType;
    filterButtonList(ui.inputList, ui.inputSearch.value);
    return;
  }

  const buttonExtension = Array.from(ui.inputList.children).find(button => {
    if (!(button instanceof HTMLButtonElement)) return false;
    const formatIndex = button.getAttribute("format-index");
    if (!formatIndex) return;
    const format = allOptions[parseInt(formatIndex)];
    return format.format.extension.toLowerCase() === fileExtension;
  });
  if (buttonExtension instanceof HTMLButtonElement) {
    buttonExtension.click();
    ui.inputSearch.value = buttonExtension.getAttribute("mime-type") || "";
  } else {
    ui.inputSearch.value = fileExtension || "";
  }
  filterButtonList(ui.inputList, ui.inputSearch.value);
}

/** Present a specific queue group for conversion */
function presentQueueGroup(index: number) {
  const group = conversionQueue[index];
  selectedFiles = group;
  renderFilePreviews(group);
  autoSelectInputFormat(group[0]);

  // Clear output selection
  const prevOutput = ui.outputList.querySelector(".selected");
  if (prevOutput) prevOutput.className = "";
  ui.convertButton.className = "disabled";
  updateProcessButton();
}

// Add the file selection handler to both the file input element and to
// the window as a drag-and-drop event, and to the clipboard paste event.
ui.fileInput.addEventListener("change", fileSelectHandler);
window.addEventListener("drop", fileSelectHandler);
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("paste", fileSelectHandler);

// ── Folder input via hidden webkitdirectory input ──

/** Hidden input element for folder selection (works on all browsers) */
const folderInput = document.createElement("input");
folderInput.type = "file";
folderInput.setAttribute("webkitdirectory", "");
folderInput.style.display = "none";
document.body.appendChild(folderInput);

folderInput.addEventListener("change", () => {
  const fileList = folderInput.files;
  if (!fileList || fileList.length === 0) return;

  // Filter out hidden/system files
  const files: File[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i];
    if (f.name.startsWith(".") || f.name.startsWith("_")) continue;
    files.push(f);
  }

  if (files.length === 0) {
    window.showPopup(
      `<h2>Empty folder</h2>` +
      `<p>No supported files found in this folder.</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );
    folderInput.value = "";
    return;
  }

  // Extract folder name from webkitRelativePath (format: "FolderName/file.ext")
  const firstPath = (fileList[0] as any).webkitRelativePath as string || "";
  activeFolderName = firstPath.split("/")[0] || "Folder";

  // Sort alphabetically for consistency
  files.sort((a, b) => a.name.localeCompare(b.name));

  // Feed into the existing pipeline
  allUploadedFiles = files;
  const categories = new Set(files.map(f => getMediaCategory(f)));
  isSameCategoryBatch = categories.size === 1;

  if (isSameCategoryBatch) {
    conversionQueue = [];
    currentQueueIndex = 0;
    selectedFiles = files;
    renderFilePreviews(files);
    autoSelectInputFormat(files[0]);
  } else {
    const groupMap = new Map<string, File[]>();
    for (const file of files) {
      const cat = getMediaCategory(file);
      if (!groupMap.has(cat)) groupMap.set(cat, []);
      groupMap.get(cat)!.push(file);
    }
    conversionQueue = Array.from(groupMap.values());
    currentQueueIndex = 0;
    presentQueueGroup(currentQueueIndex);
  }
  updateProcessButton();
  folderInput.value = "";
});

/** Append the "Open Folder" button to the file area */
function appendFolderButton() {
  const btn = document.createElement("button");
  btn.className = "browse-btn folder-btn";
  btn.textContent = "Open Folder";
  btn.onclick = (e) => {
    e.stopPropagation();
    folderInput.click();
  };
  ui.fileSelectArea.appendChild(btn);
}

// Inject the folder button on initial load
appendFolderButton();

/**
 * Display an on-screen popup.
 * @param html HTML content of the popup box.
 */
window.showPopup = function (html: string) {
  ui.popupBox.innerHTML = html;
  ui.popupBox.style.display = "block";
  ui.popupBackground.style.display = "block";
}
/**
 * Hide the on-screen popup.
 */
window.hidePopup = function () {
  ui.popupBox.style.display = "none";
  ui.popupBackground.style.display = "none";
}

const allOptions: Array<{ format: FileFormat, handler: FormatHandler }> = [];

window.supportedFormatCache = new Map();
window.traversionGraph = new TraversionGraph();

window.printSupportedFormatCache = () => {
  const entries = [];
  for (const entry of window.supportedFormatCache) {
    entries.push(entry);
  }
  return JSON.stringify(entries, null, 2);
}


/** Renders category filter pill buttons above a format list */
function renderCategoryFilters(container: HTMLDivElement, listEl: HTMLDivElement, isInput: boolean) {
  // Remove existing filter row if any
  container.querySelector(".category-filters")?.remove();

  const row = document.createElement("div");
  row.className = "category-filters";

  const categories = [
    { label: "All", value: "all" },
    { label: "Image", value: "image" },
    { label: "Video", value: "video" },
    { label: "Code", value: "code" },
    { label: "Other", value: "other" },
  ];

  for (const cat of categories) {
    const btn = document.createElement("button");
    btn.className = "category-filter-btn" + ((isInput ? inputCategoryFilter : outputCategoryFilter) === cat.value ? " active" : "");
    btn.textContent = cat.label;
    btn.type = "button";
    btn.onclick = () => {
      if (isInput) inputCategoryFilter = cat.value;
      else outputCategoryFilter = cat.value;
      // Update active states
      for (const b of Array.from(row.children) as HTMLButtonElement[]) {
        b.classList.remove("active");
      }
      btn.classList.add("active");
      applyCombinedFilter(listEl, isInput);
    };
    row.appendChild(btn);
  }

  // Insert between search input and the format-list div
  const formatList = container.querySelector(".format-list");
  if (formatList) {
    container.insertBefore(row, formatList);
  } else {
    container.appendChild(row);
  }
}

async function buildOptionList () {

  allOptions.length = 0;
  ui.inputList.innerHTML = "";
  ui.outputList.innerHTML = "";

  for (const handler of handlers) {
    if (!window.supportedFormatCache.has(handler.name)) {
      console.warn(`Cache miss for formats of handler "${handler.name}".`);
      try {
        await handler.init();
      } catch (_) { continue; }
      if (handler.supportedFormats) {
        window.supportedFormatCache.set(handler.name, handler.supportedFormats);
        console.info(`Updated supported format cache for "${handler.name}".`);
      }
    }
    const supportedFormats = window.supportedFormatCache.get(handler.name);
    if (!supportedFormats) {
      console.warn(`Handler "${handler.name}" doesn't support any formats.`);
      continue;
    }
    for (const format of supportedFormats) {

      if (!format.mime) continue;

      allOptions.push({ format, handler });

      // In simple mode, display each input/output format only once
      let addToInputs = true, addToOutputs = true;
      if (simpleMode) {
        addToInputs = !Array.from(ui.inputList.children).some(c => {
          const currFormat = allOptions[parseInt(c.getAttribute("format-index") || "")]?.format;
          return currFormat?.mime === format.mime && currFormat?.format === format.format;
        });
        addToOutputs = !Array.from(ui.outputList.children).some(c => {
          const currFormat = allOptions[parseInt(c.getAttribute("format-index") || "")]?.format;
          return currFormat?.mime === format.mime && currFormat?.format === format.format;
        });
        if ((!format.from || !addToInputs) && (!format.to || !addToOutputs)) continue;
      }

      const newOption = document.createElement("button");
      newOption.setAttribute("format-index", (allOptions.length - 1).toString());
      newOption.setAttribute("mime-type", format.mime);

      const formatDescriptor = format.format.toUpperCase();
      if (simpleMode) {
        // Hide any handler-specific information in simple mode
        const cleanName = format.name
          .split("(").join(")").split(")")
          .filter((_, i) => i % 2 === 0)
          .filter(c => c != "")
          .join(" ");
        newOption.appendChild(document.createTextNode(`${formatDescriptor} - ${cleanName} (${format.mime})`));
      } else {
        newOption.appendChild(document.createTextNode(`${formatDescriptor} - ${format.name} (${format.mime}) ${handler.name}`));
      }

      const clickHandler = (event: Event) => {
        if (!(event.target instanceof HTMLButtonElement)) return;

        // Restore queue grouping if archive mode had suspended it
        if (archiveSuspendedQueue) {
          // Deselect archive buttons
          ui.archiveFmtBtns.forEach(b => b.classList.remove("selected"));
          ui.createArchiveBtn.className = "disabled";
          restoreQueueFromArchive();
        }

        const targetParent = event.target.parentElement;
        const previous = targetParent?.getElementsByClassName("selected")?.[0];
        if (previous) previous.className = "";
        event.target.className = "selected";
        const allSelected = document.getElementsByClassName("selected");
        // In same-category batch mode with mixed exact formats, only output selection is needed
        const outputSelected = ui.outputList.querySelector(".selected");
        if (isSameCategoryBatch && allUploadedFiles.length > 1 && outputSelected) {
          ui.convertButton.className = "";
          ui.convertButton.textContent = "Convert";
          ui.convertButton.removeAttribute("data-process-mode");
        } else if (allSelected.length === 2) {
          ui.convertButton.className = "";
          ui.convertButton.textContent = "Convert";
          ui.convertButton.removeAttribute("data-process-mode");
        } else {
          ui.convertButton.className = "disabled";
        }
        updateProcessButton();
      };

      if (format.from && addToInputs) {
        const clone = newOption.cloneNode(true) as HTMLButtonElement;
        clone.onclick = clickHandler;
        ui.inputList.appendChild(clone);
      }
      if (format.to && addToOutputs) {
        const clone = newOption.cloneNode(true) as HTMLButtonElement;
        clone.onclick = clickHandler;
        ui.outputList.appendChild(clone);
      }

    }
  }
  window.traversionGraph.init(window.supportedFormatCache, handlers);

  // Render category filters above each format list
  const inputContainer = ui.inputList.parentElement as HTMLDivElement;
  const outputContainer = ui.outputList.parentElement as HTMLDivElement;
  if (inputContainer) renderCategoryFilters(inputContainer, ui.inputList, true);
  if (outputContainer) renderCategoryFilters(outputContainer, ui.outputList, false);

  // Reset category filters on rebuild
  inputCategoryFilter = "all";
  outputCategoryFilter = "all";

  filterButtonList(ui.inputList, ui.inputSearch.value);
  filterButtonList(ui.outputList, ui.outputSearch.value);

  window.hidePopup();

}

(async () => {
  try {
    const cacheJSON = await fetch("cache.json").then(r => r.json());
    window.supportedFormatCache = new Map(cacheJSON);
  } catch {
    console.warn(
      "Missing supported format precache.\n\n" +
      "Consider saving the output of printSupportedFormatCache() to cache.json."
    );
  } finally {
    await buildOptionList();
    console.log("Built initial format list.");
  }
})();

ui.modeToggleButton.addEventListener("click", () => {
  simpleMode = !simpleMode;
  if (simpleMode) {
    ui.modeToggleButton.textContent = "Advanced mode";
    document.body.style.setProperty("--highlight-color", "#1C77FF");
  } else {
    ui.modeToggleButton.textContent = "Simple mode";
    document.body.style.setProperty("--highlight-color", "#FF6F1C");
  }
  buildOptionList();
});

// ──── Theme Toggle ────
function applyTheme(theme: string) {
  document.documentElement.classList.add("theme-transitioning");
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("convert-theme", theme); } catch {}
  setTimeout(() => document.documentElement.classList.remove("theme-transitioning"), 350);
}
try {
  const savedTheme = localStorage.getItem("convert-theme") || "dark";
  applyTheme(savedTheme);
} catch { applyTheme("dark"); }

if (ui.themeToggle) {
  ui.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });
}

// ──── Settings Drawer Toggle ────
if (ui.settingsToggle && ui.settingsDrawer) {
  ui.settingsToggle.addEventListener("click", () => {
    ui.settingsDrawer.classList.toggle("hidden");
    if (!ui.settingsDrawer.classList.contains("hidden")) {
      const list = document.getElementById("app-log-list");
      if (list) _renderAppLogInto(list);
    }
  });
}

// ──── Accent Color Picker ────
const customSlot1 = document.getElementById("custom-slot-1") as HTMLButtonElement;
const customSlot2 = document.getElementById("custom-slot-2") as HTMLButtonElement;
const customSlot3 = document.getElementById("custom-slot-3") as HTMLButtonElement;
const saveCustomBtn = document.getElementById("save-custom-color") as HTMLButtonElement;
let nextCustomSlot = 1;

function updateNextSlotIndicator() {
  [customSlot1, customSlot2, customSlot3].forEach((el, i) => {
    el?.classList.toggle("custom-slot-next", i + 1 === nextCustomSlot);
  });
}

function applyAccent(color: string) {
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--highlight-color", color);
  try { localStorage.setItem("convert-accent", color); } catch {}
  ui.accentColors.forEach(dot => {
    dot.classList.toggle("active", dot.getAttribute("data-color") === color);
  });
  if (ui.customAccent) ui.customAccent.value = color;
}

function restoreCustomSlots() {
  try {
    const slots = [
      { key: "convert-custom-color-1", el: customSlot1 },
      { key: "convert-custom-color-2", el: customSlot2 },
      { key: "convert-custom-color-3", el: customSlot3 },
    ];
    for (const { key, el } of slots) {
      const c = localStorage.getItem(key);
      if (c && el) {
        el.style.setProperty("background", c, "important");
        el.setAttribute("data-color", c);
        el.classList.add("has-color");
      }
    }
  } catch {}
}
restoreCustomSlots();
updateNextSlotIndicator();

try {
  const savedAccent = localStorage.getItem("convert-accent") || "#6C5CE7";
  applyAccent(savedAccent);
} catch { applyAccent("#6C5CE7"); }

ui.accentColors.forEach(dot => {
  dot.addEventListener("click", () => {
    const color = dot.getAttribute("data-color");
    if (color) applyAccent(color);
    const slot = (dot as HTMLButtonElement).dataset["slot"];
    if (slot) {
      nextCustomSlot = parseInt(slot, 10);
      updateNextSlotIndicator();
    }
  });
});
if (ui.customAccent) {
  ui.customAccent.addEventListener("input", () => {
    applyAccent(ui.customAccent.value);
  });
}
if (saveCustomBtn) {
  saveCustomBtn.addEventListener("click", () => {
    const color = ui.customAccent?.value;
    if (!color) return;
    const slot = nextCustomSlot === 1 ? customSlot1 : nextCustomSlot === 2 ? customSlot2 : customSlot3;
    const key = `convert-custom-color-${nextCustomSlot}`;
    if (slot) {
      slot.style.setProperty("background", color, "important");
      slot.setAttribute("data-color", color);
      slot.classList.add("has-color");
    }
    try { localStorage.setItem(key, color); } catch {}
    applyAccent(color);
    nextCustomSlot = nextCustomSlot >= 3 ? 1 : nextCustomSlot + 1;
    updateNextSlotIndicator();
  });
}

// ──── Error Log Buttons ────
const copyLogBtn = document.getElementById("copy-log-btn");
if (copyLogBtn) {
  copyLogBtn.addEventListener("click", () => {
    const text = appLogBuffer
      .map(e => `[${e.time}] ${e.level.toUpperCase()} ${e.msg}`)
      .join("\n");
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      (copyLogBtn as HTMLButtonElement).textContent = "Copied!";
      setTimeout(() => { (copyLogBtn as HTMLButtonElement).textContent = "Copy log"; }, 2000);
    }).catch(() => {});
  });
}
const clearLogBtn = document.getElementById("clear-log-btn");
if (clearLogBtn) {
  clearLogBtn.addEventListener("click", () => {
    appLogBuffer.length = 0;
    const list = document.getElementById("app-log-list");
    if (list) _renderAppLogInto(list);
    const badge = document.getElementById("log-badge");
    if (badge) { badge.textContent = "0"; badge.classList.add("hidden"); }
  });
}

// ──── Auto-download Toggle ────
if (ui.autoDownloadToggle) {
  ui.autoDownloadToggle.textContent = autoDownload ? "Auto-download: On" : "Auto-download: Off";
  ui.autoDownloadToggle.classList.toggle("active", autoDownload);
  ui.autoDownloadToggle.addEventListener("click", () => {
    autoDownload = !autoDownload;
    ui.autoDownloadToggle.textContent = autoDownload ? "Auto-download: On" : "Auto-download: Off";
    ui.autoDownloadToggle.classList.toggle("active", autoDownload);
    try { localStorage.setItem("convert-auto-download", String(autoDownload)); } catch {}
  });
}

// ──── Archive Multi-file Output Toggle ────
if (ui.archiveMultiToggle) {
  ui.archiveMultiToggle.textContent = archiveMultiOutput ? "Multi-file output: Archive" : "Multi-file output: Separate";
  ui.archiveMultiToggle.classList.toggle("active", archiveMultiOutput);
  ui.archiveMultiToggle.addEventListener("click", () => {
    archiveMultiOutput = !archiveMultiOutput;
    ui.archiveMultiToggle.textContent = archiveMultiOutput ? "Multi-file output: Archive" : "Multi-file output: Separate";
    ui.archiveMultiToggle.classList.toggle("active", archiveMultiOutput);
    try { localStorage.setItem("convert-archive-multi", String(archiveMultiOutput)); } catch {}
  });
}

// ──── Remove Background Toggles ────
function updateBgUI() {
  if (ui.bgModeToggle) ui.bgModeToggle.classList.toggle("hidden", !removeBg);
  if (ui.bgCorrectionToggle) ui.bgCorrectionToggle.classList.toggle("hidden", !removeBg || bgMode === "api");
  if (ui.bgApiKeyRow) ui.bgApiKeyRow.classList.toggle("hidden", !removeBg || bgMode !== "api");
}

if (ui.removeBgToggle) {
  ui.removeBgToggle.textContent = removeBg ? "Remove background: On" : "Remove background: Off";
  ui.removeBgToggle.classList.toggle("active", removeBg);
  updateBgUI();
  ui.removeBgToggle.addEventListener("click", () => {
    removeBg = !removeBg;
    ui.removeBgToggle.textContent = removeBg ? "Remove background: On" : "Remove background: Off";
    ui.removeBgToggle.classList.toggle("active", removeBg);
    updateBgUI();
    try { localStorage.setItem("convert-remove-bg", String(removeBg)); } catch {}
    updateProcessButton();
  });
}

if (ui.bgModeToggle) {
  ui.bgModeToggle.textContent = bgMode === "local" ? "Mode: Local" : "Mode: remove.bg API";
  ui.bgModeToggle.addEventListener("click", () => {
    bgMode = bgMode === "local" ? "api" : "local";
    ui.bgModeToggle.textContent = bgMode === "local" ? "Mode: Local" : "Mode: remove.bg API";
    updateBgUI();
    try { localStorage.setItem("convert-bg-mode", bgMode); } catch {}
  });
}

if (ui.bgCorrectionToggle) {
  ui.bgCorrectionToggle.textContent = bgCorrection ? "Correction: On" : "Correction: Off";
  ui.bgCorrectionToggle.classList.toggle("active", bgCorrection);
  ui.bgCorrectionToggle.addEventListener("click", () => {
    bgCorrection = !bgCorrection;
    ui.bgCorrectionToggle.textContent = bgCorrection ? "Correction: On" : "Correction: Off";
    ui.bgCorrectionToggle.classList.toggle("active", bgCorrection);
    try { localStorage.setItem("convert-bg-correction", String(bgCorrection)); } catch {}
  });
}

if (ui.bgApiKeyInput) {
  ui.bgApiKeyInput.value = bgApiKey;
  ui.bgApiKeyInput.addEventListener("input", () => {
    bgApiKey = ui.bgApiKeyInput.value.trim();
    try { localStorage.setItem("convert-bg-api-key", bgApiKey); } catch {}
  });
}
updateBgUI();

// ──── Image Rescale Toggle ────
if (ui.rescaleToggle) {
  ui.rescaleToggle.textContent = rescaleEnabled ? "Rescale images: On" : "Rescale images: Off";
  ui.rescaleToggle.classList.toggle("active", rescaleEnabled);
  if (ui.rescaleOptions) ui.rescaleOptions.classList.toggle("hidden", !rescaleEnabled);
  ui.rescaleToggle.addEventListener("click", () => {
    rescaleEnabled = !rescaleEnabled;
    ui.rescaleToggle.textContent = rescaleEnabled ? "Rescale images: On" : "Rescale images: Off";
    ui.rescaleToggle.classList.toggle("active", rescaleEnabled);
    if (ui.rescaleOptions) ui.rescaleOptions.classList.toggle("hidden", !rescaleEnabled);
    try { localStorage.setItem("convert-rescale", String(rescaleEnabled)); } catch {}
    updateProcessButton();
  });
}
function updateRescalePlaceholders() {
  if (!ui.rescaleWidthInput || !ui.rescaleHeightInput) return;
  if (rescaleLockRatio) {
    ui.rescaleWidthInput.placeholder = rescaleWidth > 0 ? "" : "auto";
    ui.rescaleHeightInput.placeholder = rescaleHeight > 0 ? "" : "auto";
  } else {
    ui.rescaleWidthInput.placeholder = "";
    ui.rescaleHeightInput.placeholder = "";
  }
}
if (ui.rescaleWidthInput) {
  if (rescaleWidth > 0) ui.rescaleWidthInput.value = String(rescaleWidth);
  ui.rescaleWidthInput.addEventListener("input", () => {
    rescaleWidth = parseInt(ui.rescaleWidthInput.value) || 0;
    if (rescaleLockRatio && rescaleWidth > 0 && ui.rescaleHeightInput) {
      rescaleHeight = 0;
      ui.rescaleHeightInput.value = "";
      try { localStorage.setItem("convert-rescale-height", "0"); } catch {}
    }
    updateRescalePlaceholders();
    try { localStorage.setItem("convert-rescale-width", String(rescaleWidth)); } catch {}
    updateProcessButton();
  });
}
if (ui.rescaleHeightInput) {
  if (rescaleHeight > 0) ui.rescaleHeightInput.value = String(rescaleHeight);
  ui.rescaleHeightInput.addEventListener("input", () => {
    rescaleHeight = parseInt(ui.rescaleHeightInput.value) || 0;
    if (rescaleLockRatio && rescaleHeight > 0 && ui.rescaleWidthInput) {
      rescaleWidth = 0;
      ui.rescaleWidthInput.value = "";
      try { localStorage.setItem("convert-rescale-width", "0"); } catch {}
    }
    updateRescalePlaceholders();
    try { localStorage.setItem("convert-rescale-height", String(rescaleHeight)); } catch {}
    updateProcessButton();
  });
}
if (ui.rescaleLockInput) {
  ui.rescaleLockInput.checked = rescaleLockRatio;
  ui.rescaleLockInput.addEventListener("change", () => {
    rescaleLockRatio = ui.rescaleLockInput.checked;
    if (rescaleLockRatio && rescaleWidth > 0 && rescaleHeight > 0) {
      // When locking with both set, keep width and clear height
      rescaleHeight = 0;
      if (ui.rescaleHeightInput) ui.rescaleHeightInput.value = "";
      try { localStorage.setItem("convert-rescale-height", "0"); } catch {}
    }
    updateRescalePlaceholders();
    try { localStorage.setItem("convert-rescale-lock", String(rescaleLockRatio)); } catch {}
  });
}
updateRescalePlaceholders();

// ──── Privacy Mode Toggle ────
if (ui.privacyToggle) {
  ui.privacyToggle.textContent = privacyMode ? "Privacy mode: On" : "Privacy mode: Off";
  ui.privacyToggle.classList.toggle("active", privacyMode);
  ui.privacyToggle.addEventListener("click", () => {
    privacyMode = !privacyMode;
    ui.privacyToggle.textContent = privacyMode ? "Privacy mode: On" : "Privacy mode: Off";
    ui.privacyToggle.classList.toggle("active", privacyMode);
    try { localStorage.setItem("convert-privacy", String(privacyMode)); } catch {}
  });
}

// ──── Compression Settings ────

function updateCompressTypeUI() {
  if (ui.compressTargetOptions) ui.compressTargetOptions.classList.toggle("hidden", compressType !== "target");
  if (ui.compressReencodeOptions) ui.compressReencodeOptions.classList.toggle("hidden", compressType !== "reencode");
  ui.compressTypeBtns.forEach(b => b.classList.toggle("selected", b.getAttribute("data-type") === compressType));
}

if (ui.compressToggle) {
  ui.compressToggle.textContent = compressEnabled ? "Compress: On" : "Compress: Off";
  ui.compressToggle.classList.toggle("active", compressEnabled);
  if (ui.compressOptions) ui.compressOptions.classList.toggle("hidden", !compressEnabled);
  ui.compressToggle.addEventListener("click", () => {
    compressEnabled = !compressEnabled;
    ui.compressToggle.textContent = compressEnabled ? "Compress: On" : "Compress: Off";
    ui.compressToggle.classList.toggle("active", compressEnabled);
    if (ui.compressOptions) ui.compressOptions.classList.toggle("hidden", !compressEnabled);
    try { localStorage.setItem("convert-compress", String(compressEnabled)); } catch {}
    updateProcessButton();
  });
}

// Compress type tabs (Target Size / Re-encode)
ui.compressTypeBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    compressType = (btn.getAttribute("data-type") as "target" | "reencode") ?? "target";
    updateCompressTypeUI();
    try { localStorage.setItem("convert-compress-type", compressType); } catch {}
    updateProcessButton();
  });
});
updateCompressTypeUI();

if (ui.compressTargetInput) {
  if (compressTargetMB > 0) ui.compressTargetInput.value = String(compressTargetMB);
  ui.compressTargetInput.addEventListener("input", () => {
    compressTargetMB = parseFloat(ui.compressTargetInput.value) || 0;
    ui.compressPresetBtns.forEach(b => b.classList.remove("selected"));
    try { localStorage.setItem("convert-compress-target", String(compressTargetMB)); } catch {}
    updateProcessButton();
  });
}

ui.compressPresetBtns.forEach(btn => {
  if (compressTargetMB === parseFloat(btn.getAttribute("data-size") ?? "0")) {
    btn.classList.add("selected");
  }
  btn.addEventListener("click", () => {
    const size = parseFloat(btn.getAttribute("data-size") ?? "0");
    compressTargetMB = size;
    if (ui.compressTargetInput) ui.compressTargetInput.value = String(size);
    ui.compressPresetBtns.forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    try { localStorage.setItem("convert-compress-target", String(compressTargetMB)); } catch {}
    updateProcessButton();
  });
});

// CRF quality presets + slider (Re-encode mode)
ui.crfPresetBtns.forEach(btn => {
  const val = parseInt(btn.getAttribute("data-crf") ?? "23");
  btn.classList.toggle("selected", val === reencodeCrf);
  btn.addEventListener("click", () => {
    reencodeCrf = val;
    if (ui.crfSlider) ui.crfSlider.value = String(val);
    if (ui.crfValue) ui.crfValue.textContent = "CRF " + val;
    ui.crfPresetBtns.forEach(b => b.classList.toggle("selected", parseInt(b.getAttribute("data-crf") ?? "0") === val));
    try { localStorage.setItem("convert-reencode-crf", String(val)); } catch {}
  });
});

if (ui.crfSlider) {
  ui.crfSlider.value = String(reencodeCrf);
  if (ui.crfValue) ui.crfValue.textContent = "CRF " + reencodeCrf;
  ui.crfSlider.addEventListener("input", () => {
    reencodeCrf = parseInt(ui.crfSlider.value) || 23;
    if (ui.crfValue) ui.crfValue.textContent = "CRF " + reencodeCrf;
    ui.crfPresetBtns.forEach(b => b.classList.toggle("selected", parseInt(b.getAttribute("data-crf") ?? "0") === reencodeCrf));
    try { localStorage.setItem("convert-reencode-crf", String(reencodeCrf)); } catch {}
  });
}

// Encoder speed presets
ui.encoderPresetBtns.forEach(btn => {
  const speed = btn.getAttribute("data-speed") ?? "balanced";
  btn.classList.toggle("selected", speed === encoderSpeed);
  btn.addEventListener("click", () => {
    encoderSpeed = speed as "fast" | "balanced" | "quality";
    ui.encoderPresetBtns.forEach(b => b.classList.toggle("selected", b.getAttribute("data-speed") === speed));
    try { localStorage.setItem("convert-encoder-speed", encoderSpeed); } catch {}
  });
});

// ──── Output Tray: Download All / Clear ────
if (ui.downloadAllBtn) {
  ui.downloadAllBtn.addEventListener("click", () => {
    for (const item of Array.from(ui.outputTrayGrid.children)) {
      if (!(item instanceof HTMLElement)) continue;
      const url = item.getAttribute("data-blob-url");
      const name = item.getAttribute("data-file-name");
      if (url && name) triggerDownload(url, name);
    }
  });
}
if (ui.clearOutputBtn) {
  ui.clearOutputBtn.addEventListener("click", () => {
    for (const url of outputTrayUrls) URL.revokeObjectURL(url);
    outputTrayUrls.length = 0;
    ui.outputTrayGrid.innerHTML = "";
    ui.outputTray.classList.remove("visible");
  });
}

let deadEndAttempts: ConvertPathNode[][];

async function attemptConvertPath (files: FileData[], path: ConvertPathNode[]) {

  const pathString = path.map(c => c.format.format).join(" → ");

  // Exit early if we've encountered a known dead end
  for (const deadEnd of deadEndAttempts) {
    let isDeadEnd = true;
    for (let i = 0; i < deadEnd.length; i++) {
      if (path[i] === deadEnd[i]) continue;
      isDeadEnd = false;
      break;
    }
    if (isDeadEnd) {
      const deadEndString = deadEnd.slice(-2).map(c => c.format.format).join(" → ");
      console.warn(`Skipping ${pathString} due to dead end near ${deadEndString}.`);
      return null;
    }
  }

  ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
    <p id="convert-search-status" class="search-status"></p>
    <p>Trying <b>${pathString}</b>...</p>
    <button onclick="window.traversionGraph.abortSearch()">Cancel</button>`;

  for (let i = 0; i < path.length - 1; i ++) {
    const handler = path[i + 1].handler;
    try {
      let supportedFormats = window.supportedFormatCache.get(handler.name);
      if (!handler.ready) {
        await handler.init();
        if (!handler.ready) throw `Handler "${handler.name}" not ready after init.`;
        if (handler.supportedFormats) {
          window.supportedFormatCache.set(handler.name, handler.supportedFormats);
          supportedFormats = handler.supportedFormats;
        }
      }
      if (!supportedFormats) throw `Handler "${handler.name}" doesn't support any formats.`;
      const inputFormat = supportedFormats.find(c =>
        c.from
        && c.mime === path[i].format.mime
        && c.format === path[i].format.format
      )!;
      files = (await Promise.all([
        handler.doConvert(files, inputFormat, path[i + 1].format),
        // Ensure that we wait long enough for the UI to update
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      ]))[0];
      if (files.some(c => !c.bytes.length)) throw "Output is empty.";
    } catch (e) {

      console.log(path.map(c => c.format.format));
      console.error(handler.name, `${path[i].format.format} → ${path[i + 1].format.format}`, e);

      // Dead ends are added both to the graph and to the attempt system.
      // The graph may still have old paths queued from before they were
      // marked as dead ends, so we catch that here.
      const deadEndPath = path.slice(0, i + 2);
      deadEndAttempts.push(deadEndPath);
      window.traversionGraph.addDeadEndPath(path.slice(0, i + 2));

      ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
        <p id="convert-search-status" class="search-status">Looking for a valid path...</p>
        <button onclick="window.traversionGraph.abortSearch()">Cancel</button>`;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return null;

    }
  }

  return { files, path };

}

window.tryConvertByTraversing = async function (
  files: FileData[],
  from: ConvertPathNode,
  to: ConvertPathNode
) {
  deadEndAttempts = [];
  window.traversionGraph.clearDeadEndPaths();

  // Show initial search popup with cancel button
  ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
    <p id="convert-search-status" class="search-status">Searching\u2026</p>
    <p id="convert-search-path" class="search-path"></p>
    <button onclick="window.traversionGraph.abortSearch()">Cancel</button>`;
  ui.popupBox.style.display = "block";
  ui.popupBackground.style.display = "block";

  // Live listener: update popup with the path currently being explored
  const searchListener = (state: string, path: ConvertPathNode[]) => {
    const pathEl = document.getElementById("convert-search-path");
    if (!pathEl) return;
    if (state === "searching") {
      pathEl.innerHTML = `Exploring <b>${path.map(p => p.format.format).join(" \u2192 ")}</b>\u2026`;
    } else if (state === "found") {
      pathEl.innerHTML = `Found route: <b>${path.map(p => p.format.format).join(" \u2192 ")}</b>`;
    }
  };
  window.traversionGraph.addPathEventListener(searchListener);

  let result = null;
  for await (const path of window.traversionGraph.searchPath(from, to, simpleMode)) {
    // Use exact output format if the target handler supports it
    if (path.at(-1)?.handler === to.handler) {
      path[path.length - 1] = to;
    }
    const attempt = await attemptConvertPath(files, path);
    if (attempt) {
      result = attempt;
      break;
    }
  }

  window.traversionGraph.removePathEventListener(searchListener);
  return result;
}

/** Track blob URLs for cleanup */
const outputTrayUrls: string[] = [];

/** Image extensions eligible for background removal */
const bgRemovalExts = new Set(["png", "webp", "avif", "tiff", "tif", "gif", "jpg", "jpeg", "bmp"]);

/** Extensions that support transparency — others get forced to PNG */
const alphaExts = new Set(["png", "webp", "avif", "tiff", "tif", "gif"]);

/** Strip metadata from an image by re-encoding through canvas */
async function stripImageMetadata(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart], { type: "image/" + ext });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);

  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);

  const outMime = (ext === "webp") ? "image/webp" : (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : "image/png";
  const outBlob = await new Promise<Blob>((res) => canvas.toBlob(b => res(b!), outMime, 1));
  return new Uint8Array(await outBlob.arrayBuffer());
}

/** Apply metadata stripping to all image files if privacy mode is on */
async function applyMetadataStrip(files: FileData[]): Promise<FileData[]> {
  if (!privacyMode) return files;
  const result: FileData[] = [];
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (bgRemovalExts.has(ext)) {
      const stripped = await stripImageMetadata(f.bytes, ext);
      result.push({ name: f.name, bytes: stripped });
    } else {
      result.push(f);
    }
  }
  return result;
}

/** Remove background via remove.bg API */
async function removeBgViaApi(fileBytes: Uint8Array, ext: string): Promise<Uint8Array> {
  if (!bgApiKey) throw new Error("No remove.bg API key provided. Add your key in Settings → Processing.");
  const sendBytes = privacyMode ? await stripImageMetadata(fileBytes, ext) : fileBytes;
  const fileName = privacyMode ? crypto.randomUUID().substring(0, 8) + "." + ext : "image." + ext;
  const formData = new FormData();
  formData.append("image_file", new Blob([sendBytes as BlobPart], { type: "image/" + ext }), fileName);
  formData.append("size", "auto");
  const resp = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": bgApiKey },
    body: formData,
    referrerPolicy: "no-referrer",
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`remove.bg API error (${resp.status}): ${errText}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

/** Remove background locally via RMBG-1.4 */
async function removeBgLocal(f: FileData, ext: string): Promise<Uint8Array> {
  const { pipeline, RawImage } = await import("@huggingface/transformers");
  const segmenter = await pipeline("image-segmentation", "briaai/RMBG-1.4", {
    device: navigator.gpu ? "webgpu" : "wasm",
  });

  const inputBlob = new Blob([f.bytes as BlobPart], { type: "image/" + ext });
  const blobUrl = URL.createObjectURL(inputBlob);
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = blobUrl; });

  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const rawImg = await RawImage.fromURL(blobUrl);
  URL.revokeObjectURL(blobUrl);
  const output = await segmenter(rawImg);
  const maskResult = (output as { mask: InstanceType<typeof RawImage> }[])[0];
  const mask = maskResult.mask;

  const resizedMask = mask.width !== img.width || mask.height !== img.height
    ? await mask.resize(img.width, img.height)
    : mask;

  const pixels = imageData.data;
  if (bgCorrection) {
    let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
    for (let i = 0; i < resizedMask.data.length; i++) {
      if (resizedMask.data[i] < 30) {
        bgR += pixels[i * 4];
        bgG += pixels[i * 4 + 1];
        bgB += pixels[i * 4 + 2];
        bgCount++;
      }
    }
    if (bgCount > 0) { bgR /= bgCount; bgG /= bgCount; bgB /= bgCount; }

    const colorThreshold = 40;
    for (let i = 0; i < resizedMask.data.length; i++) {
      if (resizedMask.data[i] >= 128) {
        pixels[i * 4 + 3] = 255;
      } else {
        const dr = pixels[i * 4] - bgR;
        const dg = pixels[i * 4 + 1] - bgG;
        const db = pixels[i * 4 + 2] - bgB;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        pixels[i * 4 + 3] = dist > colorThreshold ? 255 : 0;
      }
    }
  } else {
    for (let i = 0; i < resizedMask.data.length; i++) {
      pixels[i * 4 + 3] = resizedMask.data[i];
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const outBlob = await new Promise<Blob>((res) => canvas.toBlob(b => res(b!), "image/png", 1));
  return new Uint8Array(await outBlob.arrayBuffer());
}

/** Apply background removal to image files if the toggle is on */
async function applyBgRemoval(files: FileData[]): Promise<FileData[]> {
  if (!removeBg) return files;
  const eligible = files.filter(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    return bgRemovalExts.has(ext);
  });
  if (eligible.length === 0) return files;

  const isApi = bgMode === "api";
  window.showPopup(
    `<h2>Removing background...</h2>` +
    `<p>${isApi ? "Sending" : "Processing"} ${eligible.length} image${eligible.length !== 1 ? "s" : ""}${isApi ? " to remove.bg" : ". This may take a moment on first run"}.</p>`
  );
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const result: FileData[] = [];
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!bgRemovalExts.has(ext)) {
      result.push(f);
      continue;
    }

    let outBytes = isApi
      ? await removeBgViaApi(f.bytes, ext)
      : await removeBgLocal(f, ext);

    // Auto-resize remove.bg API output back to original dimensions
    if (isApi) {
      outBytes = await resizeToMatch(outBytes, f.bytes, ext);
    }

    const baseName = f.name.replace(/\.[^.]+$/, "");
    const supportsAlpha = alphaExts.has(ext);
    const outName = supportsAlpha ? f.name : baseName + ".png";
    result.push({ name: outName, bytes: outBytes });
  }
  return result;
}

/** Resize image bytes to match the dimensions of a reference image */
async function resizeToMatch(imgBytes: Uint8Array, refBytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const [imgDims, refDims] = await Promise.all([
    getImageDimensions(imgBytes, ext),
    getImageDimensions(refBytes, ext),
  ]);
  if (imgDims.w === refDims.w && imgDims.h === refDims.h) return imgBytes;
  return resizeImageBytes(imgBytes, ext, refDims.w, refDims.h);
}

/** Lazy-init ImageMagick WASM (called once, cached) */
let magickReady: Promise<void> | null = null;
async function ensureMagick() {
  if (!magickReady) {
    magickReady = (async () => {
      const { initializeImageMagick } = await import("@imagemagick/magick-wasm");
      const wasmResponse = await fetch("/wasm/magick.wasm");
      const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await initializeImageMagick(wasmBytes as any);
    })();
  }
  await magickReady;
}

/** Get dimensions of an image from its bytes via ImageMagick */
async function getImageDimensions(bytes: Uint8Array, _ext: string): Promise<{ w: number; h: number }> {
  await ensureMagick();
  const { ImageMagick } = await import("@imagemagick/magick-wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ImageMagick.read(bytes as any, (img: any) => {
    return { w: img.width as number, h: img.height as number };
  });
}

/** Resize image bytes to target dimensions via ImageMagick (lossless) */
async function resizeImageBytes(bytes: Uint8Array, ext: string, w: number, h: number): Promise<Uint8Array> {
  await ensureMagick();
  const { ImageMagick, MagickFormat } = await import("@imagemagick/magick-wasm");
  const extToMagickFormat: Record<string, typeof MagickFormat[keyof typeof MagickFormat]> = {
    png: MagickFormat.Png, webp: MagickFormat.WebP, avif: MagickFormat.Avif,
    tiff: MagickFormat.Tiff, tif: MagickFormat.Tiff, gif: MagickFormat.Gif,
    jpg: MagickFormat.Jpeg, jpeg: MagickFormat.Jpeg, bmp: MagickFormat.Bmp,
    ico: MagickFormat.Ico, svg: MagickFormat.Svg,
  };
  const fmt = extToMagickFormat[ext] ?? MagickFormat.Png;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ImageMagick.read(bytes as any, (img: any) => {
    img.resize(w, h);
    img.quality = 100;
    return img.write(fmt, (out: any) => new Uint8Array(out));
  });
}

/** Image extensions eligible for rescaling */
const rescaleExts = new Set(["png", "webp", "avif", "tiff", "tif", "gif", "jpg", "jpeg", "bmp", "ico", "svg"]);

/** Apply user-specified rescaling to image files */
async function applyRescale(files: FileData[]): Promise<FileData[]> {
  if (!rescaleEnabled || (rescaleWidth <= 0 && rescaleHeight <= 0)) return files;

  const result: FileData[] = [];
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!rescaleExts.has(ext)) {
      result.push(f);
      continue;
    }

    const dims = await getImageDimensions(f.bytes, ext);
    let targetW = rescaleWidth || 0;
    let targetH = rescaleHeight || 0;

    if (targetW > 0 && targetH <= 0) {
      // Only width set — calculate height from aspect ratio
      targetH = Math.round(dims.h * (targetW / dims.w));
    } else if (targetH > 0 && targetW <= 0) {
      // Only height set — calculate width from aspect ratio
      targetW = Math.round(dims.w * (targetH / dims.h));
    }

    if (targetW === dims.w && targetH === dims.h) {
      result.push(f);
      continue;
    }

    const resized = await resizeImageBytes(f.bytes, ext, targetW, targetH);
    result.push({ name: f.name, bytes: resized });
  }
  return result;
}

/** Apply file compression (target size or quality re-encode) */
async function applyCompression(files: FileData[]): Promise<FileData[]> {
  if (!compressEnabled) return files;
  if (compressType === "reencode") {
    return await applyFileCompression(files, 0, compressMode, encoderSpeed, reencodeCrf);
  }
  if (compressTargetMB <= 0) return files;
  const targetBytes = compressTargetMB * 1024 * 1024;
  return await applyFileCompression(files, targetBytes, compressMode, encoderSpeed);
}

/** Update the convert button to show "Process" mode when processing settings are active but no output format is selected */
function updateProcessButton() {
  const hasFiles = selectedFiles.length > 0;
  const hasImageFiles = hasFiles && selectedFiles.some(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    return rescaleExts.has(ext) || bgRemovalExts.has(ext);
  });
  const rescaleReady = rescaleEnabled && (rescaleWidth > 0 || rescaleHeight > 0);
  const compressReady = compressEnabled && (compressType === "reencode" || compressTargetMB > 0);
  const hasImageProcessing = rescaleReady || removeBg;
  const hasProcessing = hasImageProcessing || compressReady;
  const outputSelected = document.querySelector("#to-list .selected");

  // Compression applies to any file, image processing only to images
  const canProcess = (hasImageFiles && hasImageProcessing) || (hasFiles && compressReady);

  if (canProcess && hasProcessing && !outputSelected) {
    const labels: string[] = [];
    if (rescaleReady) labels.push("Resize");
    if (removeBg) labels.push("Remove background");
    if (compressReady) labels.push(compressType === "reencode" ? "Re-encode" : "Compress");
    ui.convertButton.textContent = labels.join(" & ");
    ui.convertButton.className = "";
    ui.convertButton.setAttribute("data-process-mode", "true");
  } else {
    ui.convertButton.textContent = "Convert";
    ui.convertButton.removeAttribute("data-process-mode");
    // Don't override enabled state if an output format is selected
    if (!outputSelected) {
      ui.convertButton.className = "disabled";
    }
  }
}

/** Trigger a browser download from a blob URL */
function triggerDownload(blobUrl: string, name: string) {
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = name;
  link.click();
}

/** Format byte count as human-readable size */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

/** Add a converted file to the output tray */
function addToOutputTray(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const blobUrl = URL.createObjectURL(blob);
  outputTrayUrls.push(blobUrl);

  const item = document.createElement("div");
  item.className = "output-item";
  item.draggable = true;
  item.setAttribute("data-blob-url", blobUrl);
  item.setAttribute("data-file-name", name);

  const thumb = document.createElement("div");
  thumb.className = "output-item-thumb";

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"];
  if (imageExts.includes(ext)) {
    const img = document.createElement("img");
    img.src = blobUrl;
    img.alt = name;
    thumb.appendChild(img);
  } else {
    const badge = document.createElement("div");
    badge.className = "file-ext-badge";
    badge.textContent = ext.toUpperCase() || "?";
    thumb.appendChild(badge);
  }

  // Download button on the thumbnail
  const dlBtn = document.createElement("button");
  dlBtn.className = "output-download-btn";
  dlBtn.title = "Download";
  dlBtn.innerHTML = "\u2913"; // downwards arrow
  dlBtn.onclick = (e) => {
    e.stopPropagation();
    triggerDownload(blobUrl, name);
  };
  thumb.appendChild(dlBtn);

  const nameEl = document.createElement("div");
  nameEl.className = "output-item-name";
  nameEl.textContent = name;
  nameEl.title = name;

  const sizeEl = document.createElement("div");
  sizeEl.className = "output-item-size";
  sizeEl.textContent = formatFileSize(bytes.length);

  item.appendChild(thumb);
  item.appendChild(nameEl);
  item.appendChild(sizeEl);

  // Drag support for drag-to-desktop (Chrome)
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData("DownloadURL", `application/octet-stream:${name}:${blobUrl}`);
    e.dataTransfer?.setData("text/uri-list", blobUrl);
  });

  ui.outputTrayGrid.appendChild(item);
  ui.outputTray.classList.add("visible");
}

function downloadFile(bytes: Uint8Array, name: string) {
  addToOutputTray(bytes, name);
  if (autoDownload) {
    const blobUrl = outputTrayUrls[outputTrayUrls.length - 1];
    triggerDownload(blobUrl, name);
  }
}

/** Whether archive mode temporarily suspended queue grouping */
let archiveSuspendedQueue = false;

/** Temporarily exit queue mode so archive sees all files */
function suspendQueueForArchive() {
  if (!archiveSuspendedQueue && allUploadedFiles.length > 0) {
    archiveSuspendedQueue = true;
    selectedFiles = [...allUploadedFiles];
    renderFilePreviews(selectedFiles);
    // Clear format selections since all-files view doesn't map to one input format
    const prevInput = ui.inputList.querySelector(".selected");
    if (prevInput) prevInput.className = "";
    const prevOutput = ui.outputList.querySelector(".selected");
    if (prevOutput) prevOutput.className = "";
    ui.convertButton.className = "disabled";
    updateProcessButton();
    ui.inputSearch.value = "";
    filterButtonList(ui.inputList, "");
  }
}

/** Restore queue grouping after archive mode is exited */
function restoreQueueFromArchive() {
  if (!archiveSuspendedQueue) return;
  archiveSuspendedQueue = false;
  if (conversionQueue.length > 1) {
    presentQueueGroup(currentQueueIndex);
  } else if (allUploadedFiles.length > 0) {
    selectedFiles = [...allUploadedFiles];
    renderFilePreviews(selectedFiles);
    autoSelectInputFormat(selectedFiles[0]);
  }
}

// Archive format toggle buttons
ui.archiveFmtBtns.forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    btn.classList.toggle("selected");
    const anySelected = Array.from(ui.archiveFmtBtns).some(b => b.classList.contains("selected"));
    ui.createArchiveBtn.className = anySelected ? "" : "disabled";

    if (anySelected) {
      suspendQueueForArchive();
    } else {
      restoreQueueFromArchive();
    }
  });
});

ui.createArchiveBtn.addEventListener("click", async () => {
  const selectedFormats = Array.from(ui.archiveFmtBtns)
    .filter(b => b.classList.contains("selected"))
    .map(b => b.getAttribute("data-format")!);

  if (!selectedFormats.length) return;
  const archiveFiles = allUploadedFiles.length ? allUploadedFiles : selectedFiles;
  if (!archiveFiles.length) return alert("No files uploaded.");

  const inputFileData: FileData[] = [];
  for (const file of archiveFiles) {
    const buffer = await file.arrayBuffer();
    inputFileData.push({ name: file.name, bytes: new Uint8Array(buffer) });
  }

  window.showPopup("<h2>Creating archives...</h2>");
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  try {
    for (const fmt of selectedFormats) {
      window.showPopup(`<h2>Creating ${fmt.toUpperCase()} archive...</h2>`);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      switch (fmt) {
        case "zip": {
          const zip = new JSZip();
          for (const f of inputFileData) zip.file(f.name, f.bytes);
          const out = await zip.generateAsync({ type: "uint8array" });
          downloadFile(out, "archive.zip");
          break;
        }
        case "tar": {
          downloadFile(createTar(inputFileData), "archive.tar");
          break;
        }
        case "tgz": {
          downloadFile(pakoGzip(createTar(inputFileData)), "archive.tar.gz");
          break;
        }
        case "gz": {
          for (const f of inputFileData) {
            downloadFile(pakoGzip(f.bytes), f.name + ".gz");
          }
          break;
        }
        case "7z": {
          window.showPopup("<h2>Loading 7-Zip tools...</h2>");
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const SevenZip = (await import("7z-wasm")).default;
          const sz = await SevenZip({ locateFile: (p: string) => `/wasm/${p}` });
          for (const f of inputFileData) sz.FS.writeFile(f.name, f.bytes);
          sz.callMain(["a", "-t7z", "archive.7z", ...inputFileData.map(f => f.name)]);
          downloadFile(sz.FS.readFile("archive.7z"), "archive.7z");
          break;
        }
      }
    }

    window.showPopup(
      `<h2>Done!</h2>` +
      `<p>Created ${selectedFormats.length} archive${selectedFormats.length > 1 ? "s" : ""}.</p>` +
      `<button onclick="window.hidePopup()">OK</button>`
    );
  } catch (e) {
    window.hidePopup();
    alert("Error creating archive:\n" + e);
    console.error(e);
  }
});

ui.convertButton.onclick = async function () {

  const inputFiles = selectedFiles;

  if (inputFiles.length === 0) {
    return alert("Select an input file.");
  }

  // ── Process mode: resize / remove background without conversion ──
  if (ui.convertButton.hasAttribute("data-process-mode")) {
    try {
      window.showPopup("<h2>Processing...</h2>");
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      let fileData: FileData[] = [];
      for (const file of inputFiles) {
        const buf = await file.arrayBuffer();
        fileData.push({ name: file.name, bytes: new Uint8Array(buf) });
      }

      fileData = await applyBgRemoval(fileData);
      fileData = await applyMetadataStrip(fileData);
      fileData = await applyRescale(fileData);
      fileData = await applyCompression(fileData);

      for (const f of fileData) {
        downloadFile(f.bytes, f.name);
      }

      const totalSize = fileData.reduce((s, f) => s + f.bytes.length, 0);
      window.showPopup(
        `<h2>Processed ${fileData.length} file${fileData.length !== 1 ? "s" : ""}!</h2>` +
        `<p>Total size: ${formatFileSize(totalSize)}</p>` +
        `<button onclick="window.hidePopup()">OK</button>`
      );
    } catch (e) {
      window.hidePopup();
      alert("Error during processing:\n" + e);
      console.error(e);
    }
    return;
  }

  const outputButton = document.querySelector("#to-list .selected");
  if (!outputButton) return alert("Specify output file format.");
  const outputOption = allOptions[Number(outputButton.getAttribute("format-index"))];
  const outputFormat = outputOption.format;

  try {

    if (isSameCategoryBatch && allUploadedFiles.length > 1) {
      // ── Same-category batch: group by exact MIME, convert all, zip if multiple outputs ──
      const groups = new Map<string, { files: File[], inputOption: { format: FileFormat; handler: FormatHandler } }>();
      for (const file of inputFiles) {
        const opt = findInputOption(file);
        if (!opt) {
          alert(`Could not determine format for "${file.name}".`);
          return;
        }
        const key = `${opt.format.mime}|${opt.format.format}`;
        if (!groups.has(key)) groups.set(key, { files: [], inputOption: opt });
        groups.get(key)!.files.push(file);
      }

      window.showPopup("<h2>Finding conversion route...</h2>");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const allOutputFiles: FileData[] = [];

      for (const group of groups.values()) {
        const { files: groupFiles, inputOption } = group;

        // If input and output are the same format, pass through
        if (inputOption.format.mime === outputFormat.mime && inputOption.format.format === outputFormat.format) {
          for (const f of groupFiles) {
            const buf = await f.arrayBuffer();
            allOutputFiles.push({ name: f.name, bytes: new Uint8Array(buf) });
          }
          continue;
        }

        const fileData: FileData[] = [];
        for (const f of groupFiles) {
          const buf = await f.arrayBuffer();
          fileData.push({ name: f.name, bytes: new Uint8Array(buf) });
        }

        const output = await window.tryConvertByTraversing(fileData, inputOption, outputOption);
        if (!output) {
          window.hidePopup();
          alert(`Failed to find conversion route for ${inputOption.format.format} → ${outputFormat.format}.`);
          return;
        }
        allOutputFiles.push(...output.files);
      }

      if (allOutputFiles.length === 0) {
        window.hidePopup();
        return;
      }

      const processedOutputFiles = await applyCompression(await applyRescale(await applyMetadataStrip(await applyBgRemoval(allOutputFiles))));

      if (processedOutputFiles.length === 1) {
        downloadFile(processedOutputFiles[0].bytes, processedOutputFiles[0].name);
      } else if (archiveMultiOutput) {
        const zip = new JSZip();
        for (const f of processedOutputFiles) zip.file(f.name, f.bytes);
        const zipBytes = await zip.generateAsync({ type: "uint8array" });
        downloadFile(zipBytes, "converted.zip");
      } else {
        for (const f of processedOutputFiles) downloadFile(f.bytes, f.name);
      }

      const totalSize = processedOutputFiles.reduce((s, f) => s + f.bytes.length, 0);
      window.showPopup(
        `<h2>Converted ${processedOutputFiles.length} file${processedOutputFiles.length !== 1 ? "s" : ""} to ${outputFormat.format}!</h2>` +
        `<p>Total size: ${formatFileSize(totalSize)}</p>` +
        (processedOutputFiles.length > 1 && archiveMultiOutput ? `<p>Results delivered as a ZIP archive.</p>` : ``) +
        `<button onclick="window.hidePopup()">OK</button>`
      );

    } else if (conversionQueue.length > 1) {
      // ── Mixed-category queue: convert current group, advance queue ──
      const inputButton = document.querySelector("#from-list .selected");
      if (!inputButton) return alert("Specify input file format.");
      const inputOption = allOptions[Number(inputButton.getAttribute("format-index"))];
      const inputFormat = inputOption.format;

      const inputFileData: FileData[] = [];
      for (const inputFile of inputFiles) {
        const inputBuffer = await inputFile.arrayBuffer();
        const inputBytes = new Uint8Array(inputBuffer);
        if (inputFormat.mime === outputFormat.mime && inputFormat.format === outputFormat.format) {
          downloadFile(inputBytes, inputFile.name);
          continue;
        }
        inputFileData.push({ name: inputFile.name, bytes: inputBytes });
      }

      if (inputFileData.length > 0) {
        window.showPopup("<h2>Finding conversion route...</h2>");
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const output = await window.tryConvertByTraversing(inputFileData, inputOption, outputOption);
        if (!output) {
          window.hidePopup();
          alert("Failed to find conversion route.");
          return;
        }

        const processedQueueFiles = await applyCompression(await applyRescale(await applyMetadataStrip(await applyBgRemoval(output.files))));
        for (const file of processedQueueFiles) {
          downloadFile(file.bytes, file.name);
        }
      }

      // Advance to next queue group
      currentQueueIndex++;
      if (currentQueueIndex < conversionQueue.length) {
        window.showPopup(
          `<h2>Group ${currentQueueIndex} of ${conversionQueue.length} done!</h2>` +
          `<p>Advancing to next group...</p>` +
          `<button onclick="window.hidePopup()">OK</button>`
        );
        // Present next group after a short delay
        setTimeout(() => {
          window.hidePopup();
          presentQueueGroup(currentQueueIndex);
        }, 1000);
      } else {
        // All groups done
        conversionQueue = [];
        currentQueueIndex = 0;
        window.showPopup(
          `<h2>All conversions complete!</h2>` +
          `<p>All ${allUploadedFiles.length} files have been converted.</p>` +
          `<button onclick="window.hidePopup()">OK</button>`
        );
      }

    } else {
      // ── Single file or single-type group: original behavior ──
      const inputButton = document.querySelector("#from-list .selected");
      if (!inputButton) return alert("Specify input file format.");
      const inputOption = allOptions[Number(inputButton.getAttribute("format-index"))];
      const inputFormat = inputOption.format;

      const inputFileData: FileData[] = [];
      for (const inputFile of inputFiles) {
        const inputBuffer = await inputFile.arrayBuffer();
        const inputBytes = new Uint8Array(inputBuffer);
        if (inputFormat.mime === outputFormat.mime && inputFormat.format === outputFormat.format) {
          downloadFile(inputBytes, inputFile.name);
          continue;
        }
        inputFileData.push({ name: inputFile.name, bytes: inputBytes });
      }

      window.showPopup("<h2>Finding conversion route...</h2>");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const output = await window.tryConvertByTraversing(inputFileData, inputOption, outputOption);
      if (!output) {
        window.hidePopup();
        alert("Failed to find conversion route.");
        return;
      }

      const processedSingleFiles = await applyCompression(await applyRescale(await applyMetadataStrip(await applyBgRemoval(output.files))));
      for (const file of processedSingleFiles) {
        downloadFile(file.bytes, file.name);
      }

      const singleTotalSize = processedSingleFiles.reduce((s, f) => s + f.bytes.length, 0);
      window.showPopup(
        `<h2>Converted ${inputOption.format.format} to ${outputOption.format.format}!</h2>` +
        `<p>Size: ${formatFileSize(singleTotalSize)}</p>` +
        `<p>Path used: <b>${output.path.map(c => c.format.format).join(" → ")}</b>.</p>\n` +
        `<button onclick="window.hidePopup()">OK</button>`
      );
    }

  } catch (e) {

    window.hidePopup();
    alert("Unexpected error while routing:\n" + e);
    console.error(e);

  }

};

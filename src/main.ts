import type { FileFormat, FileData, FormatHandler, ConvertPathNode } from "./FormatHandler.js";
import normalizeMimeType from "./normalizeMimeType.js";
import handlers from "./handlers";
import { TraversionGraph } from "./TraversionGraph.js";
import JSZip from "jszip";
import { gzip as pakoGzip } from "pako";
import { createTar } from "./handlers/archive.js";

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

/** Queue for mixed-category batch conversion */
let conversionQueue: File[][] = [];
let currentQueueIndex = 0;
/** True when all uploaded files share the same media category */
let isSameCategoryBatch = false;
/** All files from the original upload (before queue splitting) */
let allUploadedFiles: File[] = [];

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
  ui.archivePanel.classList.remove("visible");
  // Clear format selections
  const prevInput = ui.inputList.querySelector(".selected");
  if (prevInput) prevInput.className = "";
  const prevOutput = ui.outputList.querySelector(".selected");
  if (prevOutput) prevOutput.className = "";
  ui.convertButton.className = "disabled";
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
}

// Add the file selection handler to both the file input element and to
// the window as a drag-and-drop event, and to the clipboard paste event.
ui.fileInput.addEventListener("change", fileSelectHandler);
window.addEventListener("drop", fileSelectHandler);
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("paste", fileSelectHandler);

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
        } else if (allSelected.length === 2) {
          ui.convertButton.className = "";
        } else {
          ui.convertButton.className = "disabled";
        }
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
  ui.autoDownloadToggle.addEventListener("click", () => {
    autoDownload = !autoDownload;
    ui.autoDownloadToggle.textContent = autoDownload ? "Auto-download: On" : "Auto-download: Off";
    try { localStorage.setItem("convert-auto-download", String(autoDownload)); } catch {}
  });
}

// ──── Archive Multi-file Output Toggle ────
if (ui.archiveMultiToggle) {
  ui.archiveMultiToggle.textContent = archiveMultiOutput ? "Multi-file output: Archive" : "Multi-file output: Separate";
  ui.archiveMultiToggle.addEventListener("click", () => {
    archiveMultiOutput = !archiveMultiOutput;
    ui.archiveMultiToggle.textContent = archiveMultiOutput ? "Multi-file output: Archive" : "Multi-file output: Separate";
    try { localStorage.setItem("convert-archive-multi", String(archiveMultiOutput)); } catch {}
  });
}

// ──── Remove Background Toggle ────
if (ui.removeBgToggle) {
  ui.removeBgToggle.textContent = removeBg ? "Remove background: On" : "Remove background: Off";
  ui.removeBgToggle.addEventListener("click", () => {
    removeBg = !removeBg;
    ui.removeBgToggle.textContent = removeBg ? "Remove background: On" : "Remove background: Off";
    try { localStorage.setItem("convert-remove-bg", String(removeBg)); } catch {}
  });
}

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
    <p>Trying <b>${pathString}</b>...</p>`;

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
        <p>Looking for a valid path...</p>`;
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
  for await (const path of window.traversionGraph.searchPath(from, to, simpleMode)) {
    // Use exact output format if the target handler supports it
    if (path.at(-1)?.handler === to.handler) {
      path[path.length - 1] = to;
    }
    const attempt = await attemptConvertPath(files, path);
    if (attempt) return attempt;
  }
  return null;
}

/** Track blob URLs for cleanup */
const outputTrayUrls: string[] = [];

/** Image extensions eligible for background removal */
const bgRemovalExts = new Set(["png", "webp", "avif", "tiff", "tif", "gif", "jpg", "jpeg", "bmp"]);

/** Map extension to a library-supported output MIME; fallback to image/png for unsupported ones */
const bgRemovalMime: Record<string, "image/png" | "image/jpeg" | "image/webp"> = {
  png: "image/png", webp: "image/webp",
  jpg: "image/jpeg", jpeg: "image/jpeg",
};

/** Apply background removal to image files if the toggle is on */
async function applyBgRemoval(files: FileData[]): Promise<FileData[]> {
  if (!removeBg) return files;
  const eligible = files.filter(f => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    return bgRemovalExts.has(ext);
  });
  if (eligible.length === 0) return files;

  window.showPopup(
    `<h2>Removing background...</h2>` +
    `<p>Processing ${eligible.length} image${eligible.length !== 1 ? "s" : ""}. This may take a moment on first run.</p>`
  );
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const { removeBackground } = await import("@imgly/background-removal");
  const result: FileData[] = [];
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!bgRemovalExts.has(ext)) {
      result.push(f);
      continue;
    }
    const outMime = bgRemovalMime[ext] ?? "image/png";
    const inputBlob = new Blob([f.bytes], { type: "image/" + ext });
    const blob = await removeBackground(inputBlob, {
      output: { format: outMime, quality: 1 }
    });
    const buf = await blob.arrayBuffer();
    result.push({ name: f.name, bytes: new Uint8Array(buf) });
  }
  return result;
}

/** Trigger a browser download from a blob URL */
function triggerDownload(blobUrl: string, name: string) {
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = name;
  link.click();
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

  item.appendChild(thumb);
  item.appendChild(nameEl);

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

      const processedOutputFiles = await applyBgRemoval(allOutputFiles);

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

      window.showPopup(
        `<h2>Converted ${processedOutputFiles.length} file${processedOutputFiles.length !== 1 ? "s" : ""} to ${outputFormat.format}!</h2>` +
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

        const processedQueueFiles = await applyBgRemoval(output.files);
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

      const processedSingleFiles = await applyBgRemoval(output.files);
      for (const file of processedSingleFiles) {
        downloadFile(file.bytes, file.name);
      }

      window.showPopup(
        `<h2>Converted ${inputOption.format.format} to ${outputOption.format.format}!</h2>` +
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

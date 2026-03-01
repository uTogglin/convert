// ── PDF Editor Tool ──────────────────────────────────────────────────────────
// Renders PDF pages with pdfjs-dist, lets users annotate with Fabric.js,
// and exports the annotated PDF with pdf-lib.

type PdeTool = "select" | "text" | "draw" | "highlight" | "image";

export function initPdfEditorTool() {
  /* ── DOM refs ── */
  const uploadSection = document.getElementById("pde-upload") as HTMLDivElement;
  const editorSection = document.getElementById("pde-editor") as HTMLDivElement;
  const dropArea = document.getElementById("pde-drop-area") as HTMLDivElement;
  const dropText = document.getElementById("pde-drop-text") as HTMLSpanElement;
  const fileInput = document.getElementById("pde-file-input") as HTMLInputElement;
  const imgInput = document.getElementById("pde-img-input") as HTMLInputElement;

  const bgCanvas = document.getElementById("pde-bg-canvas") as HTMLCanvasElement;
  const fabricCanvasEl = document.getElementById("pde-fabric-canvas") as HTMLCanvasElement;

  const prevBtn = document.getElementById("pde-prev") as HTMLButtonElement;
  const nextBtn = document.getElementById("pde-next") as HTMLButtonElement;
  const pageInfo = document.getElementById("pde-page-info") as HTMLSpanElement;
  const zoomInBtn = document.getElementById("pde-zoom-in") as HTMLButtonElement;
  const zoomOutBtn = document.getElementById("pde-zoom-out") as HTMLButtonElement;
  const zoomLabel = document.getElementById("pde-zoom-label") as HTMLSpanElement;
  const downloadBtn = document.getElementById("pde-download") as HTMLButtonElement;

  const undoBtn = document.getElementById("pde-undo") as HTMLButtonElement;
  const redoBtn = document.getElementById("pde-redo") as HTMLButtonElement;
  const deleteBtn = document.getElementById("pde-delete-obj") as HTMLButtonElement;

  const colorInput = document.getElementById("pde-color") as HTMLInputElement;
  const colorHex = document.getElementById("pde-color-hex") as HTMLSpanElement;
  const textProps = document.getElementById("pde-text-props") as HTMLDivElement;
  const drawProps = document.getElementById("pde-draw-props") as HTMLDivElement;
  const brushInput = document.getElementById("pde-brush-size") as HTMLInputElement;
  const brushLabel = document.getElementById("pde-brush-label") as HTMLSpanElement;
  const fontInput = document.getElementById("pde-font-size") as HTMLInputElement;
  const fontFamilySelect = document.getElementById("pde-font-family") as HTMLSelectElement;
  const boldBtn = document.getElementById("pde-bold") as HTMLButtonElement;
  const italicBtn = document.getElementById("pde-italic") as HTMLButtonElement;
  const underlineBtn = document.getElementById("pde-underline") as HTMLButtonElement;
  const strikeBtn = document.getElementById("pde-strikethrough") as HTMLButtonElement;
  const bulletBtn = document.getElementById("pde-bullet") as HTMLButtonElement;
  const alignBtns = document.querySelectorAll<HTMLButtonElement>("[data-pde-align]");
  const opacityInput = document.getElementById("pde-opacity") as HTMLInputElement;
  const opacityLabel = document.getElementById("pde-opacity-label") as HTMLSpanElement;
  const thumbnailsContainer = document.getElementById("pde-thumbnails") as HTMLDivElement;

  /* ── State ── */
  let pdfDoc: any = null;
  let pdfBytes: Uint8Array | null = null;
  let pdfFileName = "document.pdf";
  let currentPage = 1;
  let totalPages = 1;
  let zoom = 1;
  let activePdeTool: PdeTool = "select";
  let fabricCanvas: any = null;
  let fabricModule: any = null;

  const pageAnnotations: Map<number, string> = new Map();
  let undoStack: string[] = [];
  let redoStack: string[] = [];
  let skipHistory = false;

  // Bullet point state
  const bulletedObjects = new WeakSet<any>();
  let bulletModeActive = false;
  let bulletGuard = false;

  // Font detection state
  const pageTextContent: Map<number, any> = new Map();

  function getDefaults() {
    const brush = (() => { try { return parseInt(localStorage.getItem("convert-pde-brush") ?? "3"); } catch { return 3; } })();
    const font = (() => { try { return parseInt(localStorage.getItem("convert-pde-font") ?? "16"); } catch { return 16; } })();
    return { brush, font };
  }

  /* ── File loading ── */
  dropArea.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) loadPdf(fileInput.files[0]);
    fileInput.value = "";
  });
  dropArea.addEventListener("dragover", (e) => { e.preventDefault(); dropArea.classList.add("drag-over"); });
  dropArea.addEventListener("dragleave", () => dropArea.classList.remove("drag-over"));
  dropArea.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.remove("drag-over");
    if (e.dataTransfer?.files?.[0]) loadPdf(e.dataTransfer.files[0]);
  });

  async function loadPdf(file: File) {
    try {
      pdfBytes = new Uint8Array(await file.arrayBuffer());
      pdfFileName = file.name;
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      // Pass a copy to pdfjs — it detaches the ArrayBuffer, and we need the original for pdf-lib export
      pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
      totalPages = pdfDoc.numPages;
      currentPage = 1;
      zoom = 1;
      pageAnnotations.clear();
      pageTextContent.clear();
      undoStack = [];
      redoStack = [];

      uploadSection.classList.add("hidden");
      editorSection.classList.remove("hidden");

      await initFabric();
      await renderPage();
      await renderThumbnails();
    } catch (err: any) {
      console.error("[PDF Editor] Failed to load PDF:", err);
      dropText.textContent = `Error: ${err?.message || "Failed to load PDF"}`;
    }
  }

  /* ── Thumbnails ── */
  async function renderThumbnails() {
    if (!pdfDoc) return;
    thumbnailsContainer.innerHTML = "";
    for (let i = 1; i <= totalPages; i++) {
      const page = await pdfDoc.getPage(i);
      const vp = page.getViewport({ scale: 0.25 });
      const c = document.createElement("canvas");
      c.width = vp.width;
      c.height = vp.height;
      const ctx = c.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const item = document.createElement("div");
      item.className = "pde-thumb" + (i === currentPage ? " active" : "");
      item.dataset.page = String(i);

      const img = document.createElement("img");
      img.src = c.toDataURL();
      img.alt = `Page ${i}`;

      const label = document.createElement("span");
      label.className = "pde-thumb-num";
      label.textContent = String(i);

      item.appendChild(img);
      item.appendChild(label);
      item.addEventListener("click", () => {
        saveCurrentAnnotations();
        currentPage = i;
        renderPage();
        updateThumbHighlight();
      });
      thumbnailsContainer.appendChild(item);
    }
  }

  function updateThumbHighlight() {
    document.querySelectorAll(".pde-thumb").forEach(el => {
      el.classList.toggle("active", parseInt((el as HTMLElement).dataset.page!) === currentPage);
    });
    document.querySelector(".pde-thumb.active")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /* ── Properties panel ── */
  function updatePropsPanel() {
    if (!fabricCanvas) return;
    const obj = fabricCanvas.getActiveObject();
    const isTextObj = obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text");

    // Show/hide property sections
    textProps.style.display = (activePdeTool === "text" || isTextObj) ? "" : "none";
    drawProps.style.display = activePdeTool === "draw" ? "" : "none";

    // Populate text properties from selected object
    if (isTextObj) {
      fontFamilySelect.value = obj.fontFamily || "Arial";
      fontInput.value = String(Math.round(obj.fontSize || 16));
      boldBtn.classList.toggle("active", obj.fontWeight === "bold");
      italicBtn.classList.toggle("active", obj.fontStyle === "italic");
      underlineBtn.classList.toggle("active", !!obj.underline);
      strikeBtn.classList.toggle("active", !!obj.linethrough);
      bulletBtn.classList.toggle("active", bulletedObjects.has(obj));
      alignBtns.forEach(b => b.classList.toggle("active", b.dataset.pdeAlign === (obj.textAlign || "left")));
      if (obj.fill && typeof obj.fill === "string") {
        colorInput.value = obj.fill;
        colorHex.textContent = obj.fill;
      }
    }

    // Opacity
    if (obj) {
      const op = Math.round((obj.opacity ?? 1) * 100);
      opacityInput.value = String(op);
      opacityLabel.textContent = `${op}%`;
    } else {
      opacityInput.value = "100";
      opacityLabel.textContent = "100%";
    }
  }

  /* ── Fabric.js initialization ── */
  async function initFabric() {
    fabricModule = await import("fabric");
    const FabricCanvas = fabricModule.Canvas || (fabricModule as any).default?.Canvas;

    if (fabricCanvas) {
      fabricCanvas.dispose();
    }

    fabricCanvas = new FabricCanvas(fabricCanvasEl, {
      isDrawingMode: false,
      selection: true,
    });

    const defaults = getDefaults();
    brushInput.value = String(defaults.brush);
    brushLabel.textContent = `${defaults.brush}px`;
    fontInput.value = String(defaults.font);

    // Explicitly create a PencilBrush for drawing/signing
    const PencilBrush = fabricModule.PencilBrush || (fabricModule as any).default?.PencilBrush;
    if (PencilBrush) {
      fabricCanvas.freeDrawingBrush = new PencilBrush(fabricCanvas);
      fabricCanvas.freeDrawingBrush.width = defaults.brush;
      fabricCanvas.freeDrawingBrush.color = colorInput.value;
    }

    // Track modifications for undo
    fabricCanvas.on("object:added", () => { if (!skipHistory) pushHistory(); });
    fabricCanvas.on("object:modified", () => { if (!skipHistory) pushHistory(); });
    fabricCanvas.on("object:removed", () => { if (!skipHistory) pushHistory(); });

    // Selection state for delete button + properties panel
    fabricCanvas.on("selection:created", () => { deleteBtn.disabled = false; updatePropsPanel(); });
    fabricCanvas.on("selection:updated", () => { deleteBtn.disabled = false; updatePropsPanel(); });
    fabricCanvas.on("selection:cleared", () => { deleteBtn.disabled = true; updatePropsPanel(); });

    // Auto-bullet on text changes
    fabricCanvas.on("text:changed", (opt: any) => {
      const obj = opt.target;
      if (!obj || !bulletedObjects.has(obj) || bulletGuard) return;
      bulletGuard = true;
      const lines = (obj.text as string).split("\n");
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("• ") && lines[i] !== "•") {
          lines[i] = "• " + lines[i];
          changed = true;
        }
      }
      if (changed) {
        obj.set("text", lines.join("\n"));
        fabricCanvas.renderAll();
      }
      bulletGuard = false;
    });

    // Click to add text
    fabricCanvas.on("mouse:down", (opt: any) => {
      if (activePdeTool === "text" && !opt.target) {
        const fabricMod = fabricModule as any;
        const IText = fabricMod.IText || fabricMod.default?.IText;
        const defaults = getDefaults();
        const pointer = fabricCanvas.getViewportPoint(opt.e);

        // Detect font from nearest PDF text
        let detectedFont: string | null = null;
        let detectedSize: number | null = null;
        const detected = detectNearestFont(pointer.x, pointer.y);
        if (detected) {
          detectedFont = detected.fontFamily;
          detectedSize = detected.fontSize;
        }

        const fontSize = detectedSize || parseInt(fontInput.value) || defaults.font;
        const fontFamily = detectedFont || fontFamilySelect.value;
        const initialText = bulletModeActive ? "• " : "Type here";

        const text = new IText(initialText, {
          left: pointer.x,
          top: pointer.y,
          fontSize,
          fill: colorInput.value,
          fontFamily,
          editable: true,
        });

        if (bulletModeActive) bulletedObjects.add(text);

        // Update UI controls to reflect detected font
        if (detectedFont) fontFamilySelect.value = detectedFont;
        if (detectedSize) fontInput.value = String(Math.round(detectedSize));

        fabricCanvas.add(text);
        fabricCanvas.setActiveObject(text);
        text.enterEditing();
        // Select all default text for easy replacement
        if (!bulletModeActive) text.selectAll();
      } else if (activePdeTool === "highlight" && !opt.target) {
        const fabricMod = fabricModule as any;
        const Rect = fabricMod.Rect || fabricMod.default?.Rect;
        const pointer = fabricCanvas.getViewportPoint(opt.e);
        const rect = new Rect({
          left: pointer.x,
          top: pointer.y,
          width: 200,
          height: 30,
          fill: "rgba(255, 255, 0, 0.35)",
          stroke: "rgba(255, 200, 0, 0.5)",
          strokeWidth: 1,
        });
        fabricCanvas.add(rect);
        fabricCanvas.setActiveObject(rect);
      }
    });

    // Image tool — convert to data URL so it survives JSON serialization
    imgInput.addEventListener("change", async () => {
      if (!imgInput.files?.[0] || !fabricCanvas) return;
      const file = imgInput.files[0];
      // Read as data URL so it's embedded in fabric JSON (blob URLs break on restore)
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      const fabricMod = fabricModule as any;
      const FabricImage = fabricMod.FabricImage || fabricMod.Image || fabricMod.default?.FabricImage || fabricMod.default?.Image;
      if (FabricImage?.fromURL) {
        const img = await FabricImage.fromURL(dataUrl);
        // Scale to fit if too large
        const maxDim = Math.min(fabricCanvas.width! / 2, fabricCanvas.height! / 2);
        if (img.width! > maxDim || img.height! > maxDim) {
          const scale = maxDim / Math.max(img.width!, img.height!);
          img.scale(scale);
        }
        img.set({ left: 50, top: 50 });
        fabricCanvas.add(img);
        fabricCanvas.setActiveObject(img);
      }
      imgInput.value = "";
    });
  }

  /* ── Font detection helpers ── */
  function mapFontFamily(pdfFamily: string): string {
    const lower = pdfFamily.toLowerCase();
    // Check specific font names first
    if (lower.includes("helvetica")) return "Helvetica";
    if (lower.includes("arial")) return "Arial";
    if (lower.includes("times")) return "Times New Roman";
    if (lower.includes("courier")) return "Courier New";
    if (lower.includes("georgia")) return "Georgia";
    if (lower.includes("verdana")) return "Verdana";
    // Generic families
    if (lower === "serif" || (lower.includes("serif") && !lower.includes("sans"))) return "Times New Roman";
    if (lower === "sans-serif" || lower.includes("sans")) return "Arial";
    if (lower === "monospace" || lower.includes("mono")) return "Courier New";
    return "Arial";
  }

  function detectNearestFont(canvasX: number, canvasY: number): { fontFamily: string; fontSize: number } | null {
    const textContent = pageTextContent.get(currentPage);
    if (!textContent || !textContent._vpTransform) return null;

    // The stored viewport transform is at scale=1. We rendered at zoom*1.5,
    // so multiply it by the current scale to get PDF→canvas coords.
    const scale = zoom * 1.5;
    const vt = textContent._vpTransform; // [a, b, c, d, e, f] at scale=1

    let bestDist = Infinity;
    let bestItem: any = null;

    for (const item of textContent.items) {
      if (!item.str || !item.transform) continue;
      // item.transform is [scaleX, skewX, skewY, scaleY, tx, ty] in PDF user space
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];

      // Apply viewport transform (scale=1) then multiply by render scale
      // Affine: cx = (vt[0]*pdfX + vt[2]*pdfY + vt[4]) * scale
      //         cy = (vt[1]*pdfX + vt[3]*pdfY + vt[5]) * scale
      const cx = (vt[0] * pdfX + vt[2] * pdfY + vt[4]) * scale;
      const cy = (vt[1] * pdfX + vt[3] * pdfY + vt[5]) * scale;

      const dist = Math.sqrt((cx - canvasX) ** 2 + (cy - canvasY) ** 2);
      if (dist < bestDist) {
        bestDist = dist;
        bestItem = item;
      }
    }

    if (!bestItem || bestDist > 150) return null;

    // Get font family from styles
    let fontFamily = "Arial";
    if (bestItem.fontName && textContent.styles?.[bestItem.fontName]) {
      const style = textContent.styles[bestItem.fontName];
      fontFamily = mapFontFamily(style.fontFamily || "Arial");
    }

    // Get font size from transform matrix — Math.abs(transform[0]) or [3] is font size in PDF pts
    const pdfPts = Math.abs(bestItem.transform[0]) || Math.abs(bestItem.transform[3]);
    // Convert to fabric canvas pixels: PDF pts * render scale
    const fontSize = pdfPts * scale;

    return { fontFamily, fontSize: Math.max(8, fontSize) };
  }

  /* ── Render PDF page ── */
  async function renderPage() {
    if (!pdfDoc || !fabricCanvas) return;

    // Save current page annotations
    saveCurrentAnnotations();

    const page = await pdfDoc.getPage(currentPage);
    const vp = page.getViewport({ scale: zoom * 1.5 }); // 1.5 base for quality

    // Size canvases
    const w = Math.round(vp.width);
    const h = Math.round(vp.height);
    bgCanvas.width = w;
    bgCanvas.height = h;
    bgCanvas.style.width = `${w}px`;
    bgCanvas.style.height = `${h}px`;
    fabricCanvas.setDimensions({ width: w, height: h });

    // Render PDF page to background canvas
    const ctx = bgCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // Extract text content for font detection (cache per page)
    if (!pageTextContent.has(currentPage)) {
      try {
        const tc = await page.getTextContent();
        // Store the viewport transform at scale=1 for coordinate conversion
        const rawVp = page.getViewport({ scale: 1 });
        tc._vpTransform = rawVp.transform; // [a, b, c, d, e, f] affine matrix
        pageTextContent.set(currentPage, tc);
      } catch { /* non-critical */ }
    }

    // Restore annotations for this page
    restoreAnnotations();

    // Update UI
    pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    updateThumbHighlight();
  }

  function saveCurrentAnnotations() {
    if (!fabricCanvas) return;
    const json = JSON.stringify(fabricCanvas.toJSON());
    pageAnnotations.set(currentPage, json);
  }

  function restoreAnnotations() {
    if (!fabricCanvas) return;
    skipHistory = true;
    fabricCanvas.clear();
    const saved = pageAnnotations.get(currentPage);
    if (saved) {
      fabricCanvas.loadFromJSON(saved).then(() => {
        fabricCanvas.renderAll();
        skipHistory = false;
      });
    } else {
      fabricCanvas.renderAll();
      skipHistory = false;
    }
  }

  /* ── Undo/Redo ── */
  function pushHistory() {
    const state = JSON.stringify(fabricCanvas.toJSON());
    undoStack.push(state);
    redoStack = [];
    if (undoStack.length > 50) undoStack.shift();
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    undoBtn.disabled = undoStack.length <= 0;
    redoBtn.disabled = redoStack.length <= 0;
  }

  undoBtn.addEventListener("click", () => {
    if (undoStack.length === 0) return;
    const current = JSON.stringify(fabricCanvas.toJSON());
    redoStack.push(current);
    const prev = undoStack.pop()!;
    skipHistory = true;
    fabricCanvas.loadFromJSON(prev).then(() => {
      fabricCanvas.renderAll();
      skipHistory = false;
      updateUndoRedoButtons();
    });
  });

  redoBtn.addEventListener("click", () => {
    if (redoStack.length === 0) return;
    const current = JSON.stringify(fabricCanvas.toJSON());
    undoStack.push(current);
    const next = redoStack.pop()!;
    skipHistory = true;
    fabricCanvas.loadFromJSON(next).then(() => {
      fabricCanvas.renderAll();
      skipHistory = false;
      updateUndoRedoButtons();
    });
  });

  /* ── Delete selected ── */
  deleteBtn.addEventListener("click", () => {
    const active = fabricCanvas?.getActiveObjects();
    if (active?.length) {
      active.forEach((obj: any) => fabricCanvas.remove(obj));
      fabricCanvas.discardActiveObject();
      fabricCanvas.renderAll();
    }
  });

  // Keyboard delete
  window.addEventListener("keydown", (e) => {
    if (!fabricCanvas || !pdfDoc) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      // Don't delete while editing text
      const active = fabricCanvas.getActiveObject();
      if (active?.isEditing) return;
      const objs = fabricCanvas.getActiveObjects();
      if (objs?.length) {
        e.preventDefault();
        objs.forEach((obj: any) => fabricCanvas.remove(obj));
        fabricCanvas.discardActiveObject();
        fabricCanvas.renderAll();
      }
    }
    // Ctrl+Z / Ctrl+Y
    if (e.ctrlKey && e.key === "z") { e.preventDefault(); undoBtn.click(); }
    if (e.ctrlKey && e.key === "y") { e.preventDefault(); redoBtn.click(); }
  });

  /* ── Tool switching ── */
  const toolBtns = document.querySelectorAll<HTMLButtonElement>(".pde-tool-btn[data-pde-tool]");
  for (const btn of toolBtns) {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.pdeTool as PdeTool;
      activePdeTool = tool;
      toolBtns.forEach(b => b.classList.toggle("active", b === btn));

      // Update properties panel visibility
      updatePropsPanel();

      if (fabricCanvas) {
        if (tool === "draw") {
          // Ensure brush exists before enabling drawing mode
          if (!fabricCanvas.freeDrawingBrush && fabricModule) {
            const PencilBrush = fabricModule.PencilBrush || (fabricModule as any).default?.PencilBrush;
            if (PencilBrush) fabricCanvas.freeDrawingBrush = new PencilBrush(fabricCanvas);
          }
          if (fabricCanvas.freeDrawingBrush) {
            fabricCanvas.freeDrawingBrush.width = parseInt(brushInput.value) || 3;
            fabricCanvas.freeDrawingBrush.color = colorInput.value;
          }
          fabricCanvas.isDrawingMode = true;
        } else {
          fabricCanvas.isDrawingMode = false;
        }
        if (tool === "select") {
          fabricCanvas.selection = true;
        }
      }

      if (tool === "image") {
        imgInput.click();
      }
    });
  }

  /* ── Tool options ── */
  colorInput.addEventListener("input", () => {
    colorHex.textContent = colorInput.value;
    if (fabricCanvas?.freeDrawingBrush && fabricCanvas.isDrawingMode) {
      fabricCanvas.freeDrawingBrush.color = colorInput.value;
    }
    // Apply to selected text object
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("fill", colorInput.value);
      fabricCanvas.renderAll();
    }
  });

  brushInput.addEventListener("input", () => {
    brushLabel.textContent = `${brushInput.value}px`;
    if (fabricCanvas?.freeDrawingBrush && fabricCanvas.isDrawingMode) {
      fabricCanvas.freeDrawingBrush.width = parseInt(brushInput.value) || 3;
    }
  });

  // Font family
  fontFamilySelect.addEventListener("change", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("fontFamily", fontFamilySelect.value);
      fabricCanvas.renderAll();
    }
  });

  // Font size
  fontInput.addEventListener("input", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("fontSize", parseInt(fontInput.value) || 16);
      fabricCanvas.renderAll();
    }
  });

  // Bold
  boldBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      const isBold = obj.fontWeight === "bold";
      obj.set("fontWeight", isBold ? "normal" : "bold");
      boldBtn.classList.toggle("active", !isBold);
      fabricCanvas.renderAll();
    }
  });

  // Italic
  italicBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      const isItalic = obj.fontStyle === "italic";
      obj.set("fontStyle", isItalic ? "normal" : "italic");
      italicBtn.classList.toggle("active", !isItalic);
      fabricCanvas.renderAll();
    }
  });

  // Underline
  underlineBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("underline", !obj.underline);
      underlineBtn.classList.toggle("active", !!obj.underline);
      fabricCanvas.renderAll();
    }
  });

  // Strikethrough
  strikeBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      obj.set("linethrough", !obj.linethrough);
      strikeBtn.classList.toggle("active", !!obj.linethrough);
      fabricCanvas.renderAll();
    }
  });

  // Bullet toggle
  bulletBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
      // Toggle bullets on existing selected text
      if (bulletedObjects.has(obj)) {
        // Remove bullets
        bulletedObjects.delete(obj);
        const lines = (obj.text as string).split("\n");
        const cleaned = lines.map((l: string) => l.startsWith("• ") ? l.slice(2) : l === "•" ? "" : l);
        obj.set("text", cleaned.join("\n"));
        bulletBtn.classList.remove("active");
      } else {
        // Add bullets
        bulletedObjects.add(obj);
        const lines = (obj.text as string).split("\n");
        const bulleted = lines.map((l: string) => l.startsWith("• ") ? l : "• " + l);
        obj.set("text", bulleted.join("\n"));
        bulletBtn.classList.add("active");
      }
      fabricCanvas.renderAll();
    } else {
      // No text selected — toggle bullet mode for next new text
      bulletModeActive = !bulletModeActive;
      bulletBtn.classList.toggle("active", bulletModeActive);
    }
  });

  // Alignment
  for (const btn of alignBtns) {
    btn.addEventListener("click", () => {
      const obj = fabricCanvas?.getActiveObject();
      if (obj && (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text")) {
        obj.set("textAlign", btn.dataset.pdeAlign!);
        alignBtns.forEach(b => b.classList.toggle("active", b === btn));
        fabricCanvas.renderAll();
      }
    });
  }

  // Opacity
  opacityInput.addEventListener("input", () => {
    opacityLabel.textContent = `${opacityInput.value}%`;
    const obj = fabricCanvas?.getActiveObject();
    if (obj) {
      obj.set("opacity", parseInt(opacityInput.value) / 100);
      fabricCanvas.renderAll();
    }
  });

  /* ── Page navigation ── */
  prevBtn.addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; renderPage(); }
  });
  nextBtn.addEventListener("click", () => {
    if (currentPage < totalPages) { currentPage++; renderPage(); }
  });

  /* ── Zoom ── */
  zoomInBtn.addEventListener("click", () => {
    zoom = Math.min(3, zoom + 0.25);
    saveCurrentAnnotations();
    renderPage();
  });
  zoomOutBtn.addEventListener("click", () => {
    zoom = Math.max(0.25, zoom - 0.25);
    saveCurrentAnnotations();
    renderPage();
  });

  /* ── Capture annotation overlay as PNG for a given page ── */
  // Renders annotations on the live fabric canvas by navigating to that page,
  // captures the canvas, then returns to the original page.
  async function capturePageAnnotations(): Promise<Map<number, string>> {
    const captures = new Map<number, string>();
    const origPage = currentPage;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const annotJson = pageAnnotations.get(pageNum);
      if (!annotJson) continue;
      const parsed = JSON.parse(annotJson);
      if (!parsed.objects || parsed.objects.length === 0) continue;

      // Navigate to the page to load its annotations on the live canvas
      currentPage = pageNum;
      await renderPage();
      // Wait a tick for fabric to finish rendering
      await new Promise(r => setTimeout(r, 50));

      // Capture the fabric canvas (annotations only, transparent bg)
      const dataUrl = fabricCanvas.toDataURL({ format: "png", multiplier: 1 });
      captures.set(pageNum, dataUrl);
    }

    // Restore original page
    currentPage = origPage;
    await renderPage();
    return captures;
  }

  /* ── Download annotated PDF ── */
  downloadBtn.addEventListener("click", async () => {
    if (!pdfBytes || !pdfDoc) return;
    downloadBtn.classList.add("disabled");
    const dlLabel = downloadBtn.querySelector("span");
    if (dlLabel) dlLabel.textContent = "Exporting...";

    try {
      saveCurrentAnnotations();

      // Capture all annotated pages as PNGs using the live fabric canvas
      const captures = await capturePageAnnotations();

      if (captures.size === 0) {
        // No annotations — just download the original
        const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = pdfFileName.replace(/\.pdf$/i, "") + "-edited.pdf";
        a.click();
        URL.revokeObjectURL(a.href);
        return;
      }

      const { PDFDocument } = await import("pdf-lib");
      const outPdf = await PDFDocument.load(pdfBytes);

      for (const [pageNum, dataUrl] of captures) {
        const pngBytes = Uint8Array.from(atob(dataUrl.split(",")[1]), c => c.charCodeAt(0));
        const pngImage = await outPdf.embedPng(pngBytes);

        const pdfPage = outPdf.getPages()[pageNum - 1];
        const { width, height } = pdfPage.getSize();

        pdfPage.drawImage(pngImage, {
          x: 0,
          y: 0,
          width,
          height,
        });
      }

      const modifiedBytes = await outPdf.save();
      const blob = new Blob([modifiedBytes.buffer as ArrayBuffer], { type: "application/pdf" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = pdfFileName.replace(/\.pdf$/i, "") + "-edited.pdf";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err: any) {
      console.error("[PDF Editor] Export error:", err);
      alert(`Export failed: ${err?.message || "Unknown error"}`);
    } finally {
      downloadBtn.classList.remove("disabled");
      const dlLabel = downloadBtn.querySelector("span");
      if (dlLabel) dlLabel.textContent = "Download";
    }
  });
}

// ── PDF Editor Tool ──────────────────────────────────────────────────────────
// Renders PDF pages with pdfjs-dist, lets users annotate with Fabric.js,
// and exports the annotated PDF with pdf-lib.

type PdeTool = "select" | "text" | "draw" | "highlight" | "image";

export function initPdfEditorTool() {
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
  const brushGroup = document.getElementById("pde-brush-group") as HTMLDivElement;
  const brushInput = document.getElementById("pde-brush-size") as HTMLInputElement;
  const brushLabel = document.getElementById("pde-brush-label") as HTMLSpanElement;
  const fontGroup = document.getElementById("pde-font-group") as HTMLDivElement;
  const fontInput = document.getElementById("pde-font-size") as HTMLInputElement;

  let pdfDoc: any = null;
  let pdfBytes: Uint8Array | null = null;
  let pdfFileName = "document.pdf";
  let currentPage = 1;
  let totalPages = 1;
  let zoom = 1;
  let activePdeTool: PdeTool = "select";
  let fabricCanvas: any = null;

  // Per-page annotation state
  const pageAnnotations: Map<number, string> = new Map();

  // Undo/redo stacks
  let undoStack: string[] = [];
  let redoStack: string[] = [];
  let skipHistory = false;

  function getDefaults() {
    const brush = (() => { try { return parseInt(localStorage.getItem("convert-pde-brush") ?? "3"); } catch { return 3; } })();
    const font = (() => { try { return parseInt(localStorage.getItem("convert-pde-font") ?? "16"); } catch { return 16; } })();
    return { brush, font };
  }

  // ── File loading ───────────────────────────────────────────────────────
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
      pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
      totalPages = pdfDoc.numPages;
      currentPage = 1;
      zoom = 1;
      pageAnnotations.clear();
      undoStack = [];
      redoStack = [];

      uploadSection.classList.add("hidden");
      editorSection.classList.remove("hidden");

      await initFabric();
      await renderPage();
    } catch (err: any) {
      console.error("[PDF Editor] Failed to load PDF:", err);
      dropText.textContent = `Error: ${err?.message || "Failed to load PDF"}`;
    }
  }

  let fabricModule: any = null;

  // ── Fabric.js initialization ───────────────────────────────────────────
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

    // Selection state for delete button
    fabricCanvas.on("selection:created", () => { deleteBtn.disabled = false; });
    fabricCanvas.on("selection:updated", () => { deleteBtn.disabled = false; });
    fabricCanvas.on("selection:cleared", () => { deleteBtn.disabled = true; });

    // Click to add text
    fabricCanvas.on("mouse:down", (opt: any) => {
      if (activePdeTool === "text" && !opt.target) {
        const fabricMod = fabricModule as any;
        const IText = fabricMod.IText || fabricMod.default?.IText;
        const defaults = getDefaults();
        const pointer = fabricCanvas.getViewportPoint(opt.e);
        const text = new IText("Type here", {
          left: pointer.x,
          top: pointer.y,
          fontSize: parseInt(fontInput.value) || defaults.font,
          fill: colorInput.value,
          fontFamily: "sans-serif",
          editable: true,
        });
        fabricCanvas.add(text);
        fabricCanvas.setActiveObject(text);
        text.enterEditing();
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

    // Image tool
    imgInput.addEventListener("change", async () => {
      if (!imgInput.files?.[0] || !fabricCanvas) return;
      const url = URL.createObjectURL(imgInput.files[0]);
      const fabricMod = fabricModule as any;
      const FabricImage = fabricMod.FabricImage || fabricMod.Image || fabricMod.default?.FabricImage || fabricMod.default?.Image;
      if (FabricImage?.fromURL) {
        const img = await FabricImage.fromURL(url);
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
      URL.revokeObjectURL(url);
    });
  }

  // ── Render PDF page ────────────────────────────────────────────────────
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

    // Set wrapper to match page size so scrolling works
    const wrap = document.getElementById("pde-canvas-wrap")!;
    wrap.style.height = `${Math.min(h + 2, window.innerHeight * 0.7)}px`;
    wrap.style.width = "100%";

    // Render PDF page to background canvas
    const ctx = bgCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // Restore annotations for this page
    restoreAnnotations();

    // Update UI
    pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
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

  // ── Undo/Redo ──────────────────────────────────────────────────────────
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

  // ── Delete selected ────────────────────────────────────────────────────
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

  // ── Tool switching ─────────────────────────────────────────────────────
  const toolBtns = document.querySelectorAll<HTMLButtonElement>(".pde-tool-btn[data-pde-tool]");
  for (const btn of toolBtns) {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.pdeTool as PdeTool;
      activePdeTool = tool;
      toolBtns.forEach(b => b.classList.toggle("active", b === btn));

      // Show/hide option groups
      brushGroup.style.display = tool === "draw" ? "flex" : "none";
      fontGroup.style.display = tool === "text" ? "flex" : "none";

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

  // Tool options
  colorInput.addEventListener("input", () => {
    if (fabricCanvas?.freeDrawingBrush && fabricCanvas.isDrawingMode) {
      fabricCanvas.freeDrawingBrush.color = colorInput.value;
    }
  });
  brushInput.addEventListener("input", () => {
    brushLabel.textContent = `${brushInput.value}px`;
    if (fabricCanvas?.freeDrawingBrush && fabricCanvas.isDrawingMode) {
      fabricCanvas.freeDrawingBrush.width = parseInt(brushInput.value) || 3;
    }
  });

  // ── Page navigation ────────────────────────────────────────────────────
  prevBtn.addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; renderPage(); }
  });
  nextBtn.addEventListener("click", () => {
    if (currentPage < totalPages) { currentPage++; renderPage(); }
  });

  // ── Zoom ───────────────────────────────────────────────────────────────
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

  // ── Download annotated PDF ─────────────────────────────────────────────
  downloadBtn.addEventListener("click", async () => {
    if (!pdfBytes || !pdfDoc) return;
    downloadBtn.classList.add("disabled");
    downloadBtn.textContent = "Exporting...";

    try {
      saveCurrentAnnotations();

      const { PDFDocument } = await import("pdf-lib");
      const outPdf = await PDFDocument.load(pdfBytes);

      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const annotJson = pageAnnotations.get(pageNum);
        if (!annotJson) continue;

        const parsed = JSON.parse(annotJson);
        if (!parsed.objects || parsed.objects.length === 0) continue;

        // Render annotations to a temp canvas
        const page = await pdfDoc.getPage(pageNum);
        const vp = page.getViewport({ scale: zoom * 1.5 });

        const tempCanvasEl = document.createElement("canvas");
        tempCanvasEl.width = vp.width;
        tempCanvasEl.height = vp.height;

        const fabricModule = await import("fabric");
        const StaticCanvas = fabricModule.StaticCanvas || (fabricModule as any).default?.StaticCanvas;
        const tempFabric = new StaticCanvas(tempCanvasEl, {
          width: vp.width,
          height: vp.height,
        });

        await tempFabric.loadFromJSON(annotJson);
        tempFabric.renderAll();

        // Get annotation image as PNG
        const dataUrl = tempCanvasEl.toDataURL("image/png");
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

        tempFabric.dispose();
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
      downloadBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Download PDF`;
    }
  });
}

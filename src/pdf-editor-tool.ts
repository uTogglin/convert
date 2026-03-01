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
  const matchTextBtn = document.getElementById("pde-match-text") as HTMLButtonElement;
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

  // Text editing state
  interface TextEdit {
    id: string;
    originalStr: string;
    pdfX: number;
    pdfY: number;
    fontSizePt: number;
    fontName: string;
    detectedFamily: string;
    bold: boolean;
    italic: boolean;
    color: string;
    newStr: string;
    deleted: boolean;
  }
  const pageTextEdits: Map<number, TextEdit[]> = new Map();
  let textEditCounter = 0;

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
      pageTextEdits.clear();
      textEditCounter = 0;
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

  let thumbUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleThumbUpdate() {
    if (thumbUpdateTimer) clearTimeout(thumbUpdateTimer);
    thumbUpdateTimer = setTimeout(updateCurrentThumbnail, 300);
  }

  function updateCurrentThumbnail() {
    if (!fabricCanvas || !bgCanvas) return;
    const thumbEl = thumbnailsContainer.querySelector(`.pde-thumb[data-page="${currentPage}"] img`) as HTMLImageElement | null;
    if (!thumbEl) return;

    // Composite PDF background + annotations into a small canvas
    const tw = 150;
    const scale = tw / bgCanvas.width;
    const th = Math.round(bgCanvas.height * scale);
    const c = document.createElement("canvas");
    c.width = tw;
    c.height = th;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bgCanvas, 0, 0, tw, th);

    // Draw fabric annotations on top
    const fabricEl = fabricCanvas.getElement();
    if (fabricEl) ctx.drawImage(fabricEl, 0, 0, tw, th);

    thumbEl.src = c.toDataURL();
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
    fabricCanvas.on("object:added", () => { if (!skipHistory) pushHistory(); scheduleThumbUpdate(); });
    fabricCanvas.on("object:modified", () => { if (!skipHistory) pushHistory(); scheduleThumbUpdate(); });
    fabricCanvas.on("object:removed", (opt: any) => {
      if (!skipHistory) pushHistory();
      scheduleThumbUpdate();
      // Handle text edit deletion — mark edit as deleted and remove paired cover rect
      const obj = opt.target;
      if (obj?._pdeTextEditId && !obj._pdeCoverRect) {
        const edits = pageTextEdits.get(currentPage);
        if (edits) {
          const edit = edits.find((e: TextEdit) => e.id === obj._pdeTextEditId);
          if (edit) edit.deleted = true;
        }
        // Remove paired cover rect
        const all = fabricCanvas.getObjects();
        for (const o of all) {
          if (o._pdeTextEditId === obj._pdeTextEditId && o._pdeCoverRect) {
            fabricCanvas.remove(o);
            break;
          }
        }
      }
    });

    // Selection state for delete button + properties panel
    fabricCanvas.on("selection:created", () => { deleteBtn.disabled = false; updatePropsPanel(); });
    fabricCanvas.on("selection:updated", () => { deleteBtn.disabled = false; updatePropsPanel(); });
    fabricCanvas.on("selection:cleared", () => { deleteBtn.disabled = true; updatePropsPanel(); });

    // Auto-bullet on text changes
    fabricCanvas.on("text:changed", (opt: any) => {
      scheduleThumbUpdate();
      const obj = opt.target;
      if (!obj) return;

      // Track text edit changes
      if (obj._pdeTextEditId && !obj._pdeCoverRect) {
        const edits = pageTextEdits.get(currentPage);
        if (edits) {
          const edit = edits.find((e: TextEdit) => e.id === obj._pdeTextEditId);
          if (edit) {
            edit.newStr = obj.text || "";
            edit.deleted = !edit.newStr;
          }
        }
      }

      if (!bulletedObjects.has(obj) || bulletGuard) return;
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

    // Click to add or edit text
    fabricCanvas.on("mouse:down", (opt: any) => {
      if (activePdeTool === "text" && !opt.target) {
        const fabricMod = fabricModule as any;
        const IText = fabricMod.IText || fabricMod.default?.IText;
        const Rect = fabricMod.Rect || fabricMod.default?.Rect;
        const defaults = getDefaults();
        const pointer = fabricCanvas.getViewportPoint(opt.e);

        // Check if clicking on existing PDF text
        const hitItem = findTextItemAtPoint(pointer.x, pointer.y);
        if (hitItem) {
          // Check if this text was already edited
          const existingEdits = pageTextEdits.get(currentPage) || [];
          const alreadyEdited = existingEdits.find(e =>
            Math.abs(e.pdfX - hitItem.pdfX) < 1 && Math.abs(e.pdfY - hitItem.pdfY) < 1
          );
          if (alreadyEdited) {
            // Already has an edit object on canvas — let user click it normally
          } else {
            // Create a cover rect matching the background color
            const bgColor = sampleBgColor(hitItem.canvasLeft, hitItem.canvasTop, hitItem.width, hitItem.height);
            const editId = `textedit-${++textEditCounter}`;

            const coverRect = new Rect({
              left: hitItem.canvasLeft,
              top: hitItem.canvasTop,
              width: hitItem.width,
              height: hitItem.height,
              fill: bgColor,
              stroke: "transparent",
              strokeWidth: 0,
              selectable: false,
              evented: false,
              _pdeTextEditId: editId,
              _pdeCoverRect: true,
            });
            fabricCanvas.add(coverRect);

            // Create editable IText with matched font
            const editText = new IText(hitItem.str, {
              left: hitItem.canvasLeft,
              top: hitItem.canvasTop,
              fontSize: hitItem.fontSize,
              fill: hitItem.color,
              fontFamily: hitItem.fontFamily,
              fontWeight: hitItem.bold ? "bold" : "normal",
              fontStyle: hitItem.italic ? "italic" : "normal",
              editable: true,
              _pdeTextEditId: editId,
              _pdeCoverRect: false,
            });

            fabricCanvas.add(editText);
            fabricCanvas.setActiveObject(editText);
            editText.enterEditing();
            editText.selectAll();

            // Record the text edit
            const textEdit: TextEdit = {
              id: editId,
              originalStr: hitItem.str,
              pdfX: hitItem.pdfX,
              pdfY: hitItem.pdfY,
              fontSizePt: hitItem.fontSizePt,
              fontName: hitItem.fontName,
              detectedFamily: hitItem.fontFamily,
              bold: hitItem.bold,
              italic: hitItem.italic,
              color: hitItem.color,
              newStr: hitItem.str,
              deleted: false,
            };
            if (!pageTextEdits.has(currentPage)) pageTextEdits.set(currentPage, []);
            pageTextEdits.get(currentPage)!.push(textEdit);
            return;
          }
        }

        // No existing text hit — create new text
        const initialText = bulletModeActive ? "• " : "Type here";
        const text = new IText(initialText, {
          left: pointer.x,
          top: pointer.y,
          fontSize: parseInt(fontInput.value) || defaults.font,
          fill: colorInput.value,
          fontFamily: fontFamilySelect.value,
          editable: true,
        });

        if (bulletModeActive) bulletedObjects.add(text);

        fabricCanvas.add(text);
        fabricCanvas.setActiveObject(text);
        text.enterEditing();
        if (!bulletModeActive) text.selectAll();
      } else if (activePdeTool === "highlight" && !opt.target) {
        const fabricMod = fabricModule as any;
        const Rect = fabricMod.Rect || fabricMod.default?.Rect;
        const pointer = fabricCanvas.getViewportPoint(opt.e);
        // Convert hex color to rgba with 35% opacity for highlight
        const hex = colorInput.value;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const rect = new Rect({
          left: pointer.x,
          top: pointer.y,
          width: 200,
          height: 30,
          fill: `rgba(${r}, ${g}, ${b}, 0.35)`,
          stroke: `rgba(${r}, ${g}, ${b}, 0.5)`,
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

  // Strip subset prefix (e.g. "BCDFEE+Calibri" → "Calibri")
  function stripSubset(name: string): string {
    return name.replace(/^[A-Z]{6}\+/, "");
  }

  // Detect bold/italic from font name (e.g. "TimesNewRomanPS-BoldItalicMT")
  function detectFontStyle(fontName: string): { bold: boolean; italic: boolean } {
    const lower = stripSubset(fontName).toLowerCase();
    return {
      bold: /bold|demi|heavy|black/i.test(lower),
      italic: /italic|oblique|slant/i.test(lower),
    };
  }

  function mapFontFamily(pdfFamily: string): string {
    const lower = stripSubset(pdfFamily).toLowerCase().replace(/[-_,\s]+/g, "");
    // Specific font families — ordered by commonality in PDFs
    if (lower.includes("arial")) return "Arial";
    if (lower.includes("helvetica")) return "Helvetica";
    if (lower.includes("timesnewroman") || lower.includes("timesnew")) return "Times New Roman";
    if (lower.includes("times")) return "Times New Roman";
    if (lower.includes("calibri")) return "Calibri";
    if (lower.includes("cambria")) return "Cambria";
    if (lower.includes("palatino") || lower.includes("palatin")) return "Palatino Linotype";
    if (lower.includes("garamond")) return "Garamond";
    if (lower.includes("bookantiqua")) return "Book Antiqua";
    if (lower.includes("georgia")) return "Georgia";
    if (lower.includes("verdana")) return "Verdana";
    if (lower.includes("tahoma")) return "Tahoma";
    if (lower.includes("trebuchet")) return "Trebuchet MS";
    if (lower.includes("couriernew") || lower.includes("courier")) return "Courier New";
    if (lower.includes("lucidaconsole")) return "Lucida Console";
    if (lower.includes("lucidasans")) return "Lucida Sans Unicode";
    if (lower.includes("consolas")) return "Consolas";
    if (lower.includes("segoeui") || lower.includes("segoe")) return "Segoe UI";
    if (lower.includes("comicsans")) return "Comic Sans MS";
    if (lower.includes("impact")) return "Impact";
    if (lower.includes("centuryschl") || lower.includes("century")) return "Georgia";
    if (lower.includes("bookman")) return "Bookman Old Style";
    if (lower.includes("nimbus") && lower.includes("rom")) return "Times New Roman";
    if (lower.includes("nimbus") && lower.includes("san")) return "Arial";
    if (lower.includes("nimbus") && lower.includes("mon")) return "Courier New";
    if (lower.includes("liberationserif") || lower.includes("freeserif")) return "Times New Roman";
    if (lower.includes("liberationsans") || lower.includes("freesans")) return "Arial";
    if (lower.includes("liberationmono") || lower.includes("freemono")) return "Courier New";
    if (lower.includes("dejavuserif")) return "Georgia";
    if (lower.includes("dejavusans") && lower.includes("mono")) return "Courier New";
    if (lower.includes("dejavusans")) return "Verdana";
    if (lower.includes("roboto")) return "Arial";
    if (lower.includes("opensans") || lower.includes("open")) return "Arial";
    if (lower.includes("lato")) return "Arial";
    if (lower.includes("sourcesans")) return "Arial";
    if (lower.includes("sourceserif")) return "Georgia";
    if (lower.includes("sourcecode")) return "Courier New";
    if (lower.includes("notosans")) return "Arial";
    if (lower.includes("notoserif")) return "Times New Roman";
    // Generic families
    if (lower === "serif" || (lower.includes("serif") && !lower.includes("sans"))) return "Times New Roman";
    if (lower === "sansserif" || lower.includes("sans")) return "Arial";
    if (lower === "monospace" || lower.includes("mono")) return "Courier New";
    return "Arial";
  }

  function detectNearestFont(canvasX: number, canvasY: number): { fontFamily: string; fontSize: number; color: string; bold: boolean; italic: boolean } | null {
    const textContent = pageTextContent.get(currentPage);
    if (!textContent || !textContent._vpTransform) return null;

    const scale = zoom * 1.5;
    const vt = textContent._vpTransform;

    let bestDist = Infinity;
    let bestItem: any = null;
    let bestCx = 0;
    let bestCy = 0;

    for (const item of textContent.items) {
      if (!item.str || !item.transform) continue;
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];

      const cx = (vt[0] * pdfX + vt[2] * pdfY + vt[4]) * scale;
      const cy = (vt[1] * pdfX + vt[3] * pdfY + vt[5]) * scale;

      const dist = Math.sqrt((cx - canvasX) ** 2 + (cy - canvasY) ** 2);
      if (dist < bestDist) {
        bestDist = dist;
        bestItem = item;
        bestCx = cx;
        bestCy = cy;
      }
    }

    if (!bestItem || bestDist > 500) return null;

    // Get font family and style from the PDF font name
    let fontFamily = "Arial";
    let bold = false;
    let italic = false;
    if (bestItem.fontName) {
      // Detect bold/italic from the raw font name (e.g. "TimesNewRomanPS-BoldItalicMT")
      const style = detectFontStyle(bestItem.fontName);
      bold = style.bold;
      italic = style.italic;

      if (textContent.styles?.[bestItem.fontName]) {
        const s = textContent.styles[bestItem.fontName];
        fontFamily = mapFontFamily(s.fontFamily || bestItem.fontName);
      } else {
        fontFamily = mapFontFamily(bestItem.fontName);
      }
    }

    // Font size: pdfjs renders glyph paths directly while fabric uses fillText
    // with system fonts. The 96/72 factor corrects for the rendering difference
    // between PDF point-based glyph scaling and CSS pixel-based font sizing.
    const pdfPts = Math.abs(bestItem.transform[0]) || Math.abs(bestItem.transform[3]);
    const fontSize = pdfPts * (96 / 72) * scale;

    // Sample text color by scanning a grid of pixels near the matched text
    // and picking the darkest one (most likely the text, not background)
    let color = "#000000";
    try {
      const ctx = bgCanvas.getContext("2d")!;
      const glyphH = pdfPts * scale;
      let darkest = 255;
      let darkR = 0, darkG = 0, darkB = 0;
      // Sample a 5x5 grid within the glyph area
      for (let dy = -0.6; dy <= -0.1; dy += 0.12) {
        for (let dx = 0.2; dx <= 0.8; dx += 0.15) {
          const sx = Math.round(bestCx + glyphH * dx);
          const sy = Math.round(bestCy + glyphH * dy);
          if (sx < 0 || sy < 0 || sx >= bgCanvas.width || sy >= bgCanvas.height) continue;
          const px = ctx.getImageData(sx, sy, 1, 1).data;
          const brightness = px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114;
          if (brightness < darkest) {
            darkest = brightness;
            darkR = px[0]; darkG = px[1]; darkB = px[2];
          }
        }
      }
      // Only use sampled color if it's clearly not background (< 200 brightness)
      if (darkest < 200) {
        color = "#" + [darkR, darkG, darkB].map(c => c.toString(16).padStart(2, "0")).join("");
      }
    } catch { /* use default black */ }

    return { fontFamily, fontSize: Math.max(8, fontSize), color, bold, italic };
  }

  /* ── Text editing: hit test + background sampling ── */

  function findTextItemAtPoint(canvasX: number, canvasY: number): {
    str: string; pdfX: number; pdfY: number; canvasLeft: number; canvasTop: number;
    width: number; height: number; fontFamily: string; fontSize: number; fontSizePt: number;
    fontName: string; color: string; bold: boolean; italic: boolean;
  } | null {
    const textContent = pageTextContent.get(currentPage);
    if (!textContent || !textContent._vpTransform) return null;

    const scale = zoom * 1.5;
    const vt = textContent._vpTransform;

    for (const item of textContent.items) {
      if (!item.str || !item.transform) continue;
      const pdfX = item.transform[4];
      const pdfY = item.transform[5];

      // Convert PDF coords to canvas coords
      const cx = (vt[0] * pdfX + vt[2] * pdfY + vt[4]) * scale;
      const cy = (vt[1] * pdfX + vt[3] * pdfY + vt[5]) * scale;

      // Compute text bounding box in canvas space
      const pdfPts = Math.abs(item.transform[0]) || Math.abs(item.transform[3]);
      const glyphH = pdfPts * scale;
      const textW = (item.width ?? 0) * scale;

      // Bounding box: text baseline is at cy, text extends upward
      const boxLeft = cx;
      const boxTop = cy - glyphH;
      const boxRight = cx + textW;
      const boxBottom = cy + glyphH * 0.3; // small descender allowance

      if (canvasX >= boxLeft - 2 && canvasX <= boxRight + 2 &&
          canvasY >= boxTop - 2 && canvasY <= boxBottom + 2) {
        // Hit! Get font info
        let fontFamily = "Arial";
        let bold = false;
        let italic = false;
        let fontName = item.fontName || "";
        if (fontName) {
          const style = detectFontStyle(fontName);
          bold = style.bold;
          italic = style.italic;
          if (textContent.styles?.[fontName]) {
            fontFamily = mapFontFamily(textContent.styles[fontName].fontFamily || fontName);
          } else {
            fontFamily = mapFontFamily(fontName);
          }
        }

        const fontSize = pdfPts * (96 / 72) * scale;

        // Sample text color
        let color = "#000000";
        try {
          const ctx = bgCanvas.getContext("2d")!;
          let darkest = 255;
          let darkR = 0, darkG = 0, darkB = 0;
          for (let dy = -0.6; dy <= -0.1; dy += 0.12) {
            for (let dx = 0.2; dx <= 0.8; dx += 0.15) {
              const sx = Math.round(cx + glyphH * dx);
              const sy = Math.round(cy + glyphH * dy);
              if (sx < 0 || sy < 0 || sx >= bgCanvas.width || sy >= bgCanvas.height) continue;
              const px = ctx.getImageData(sx, sy, 1, 1).data;
              const brightness = px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114;
              if (brightness < darkest) {
                darkest = brightness;
                darkR = px[0]; darkG = px[1]; darkB = px[2];
              }
            }
          }
          if (darkest < 200) {
            color = "#" + [darkR, darkG, darkB].map(c => c.toString(16).padStart(2, "0")).join("");
          }
        } catch { /* default black */ }

        return {
          str: item.str, pdfX, pdfY,
          canvasLeft: boxLeft, canvasTop: boxTop,
          width: Math.max(textW, 20), height: glyphH * 1.3,
          fontFamily, fontSize: Math.max(8, fontSize), fontSizePt: pdfPts,
          fontName, color, bold, italic,
        };
      }
    }
    return null;
  }

  function sampleBgColor(x: number, y: number, w: number, h: number): string {
    try {
      const ctx = bgCanvas.getContext("2d")!;
      // Sample pixels around the edges of the bounding box (background, not text)
      let totalR = 0, totalG = 0, totalB = 0, count = 0;
      const offsets = [
        [x - 3, y + h / 2], [x + w + 3, y + h / 2],       // left/right of box
        [x + w / 2, y - 3], [x + w / 2, y + h + 3],       // above/below box
        [x - 3, y - 3], [x + w + 3, y - 3],                // corners above
        [x - 3, y + h + 3], [x + w + 3, y + h + 3],       // corners below
      ];
      for (const [sx, sy] of offsets) {
        const px = Math.round(sx);
        const py = Math.round(sy);
        if (px < 0 || py < 0 || px >= bgCanvas.width || py >= bgCanvas.height) continue;
        const pd = ctx.getImageData(px, py, 1, 1).data;
        totalR += pd[0]; totalG += pd[1]; totalB += pd[2];
        count++;
      }
      if (count > 0) {
        const r = Math.round(totalR / count);
        const g = Math.round(totalG / count);
        const b = Math.round(totalB / count);
        return "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("");
      }
    } catch { /* fallback */ }
    return "#ffffff";
  }

  /* ── Render PDF page ── */
  async function renderPage() {
    if (!pdfDoc || !fabricCanvas) return;

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
    const json = JSON.stringify(fabricCanvas.toJSON(["_pdeTextEditId", "_pdeCoverRect"]));
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
    const state = JSON.stringify(fabricCanvas.toJSON(["_pdeTextEditId", "_pdeCoverRect"]));
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
      scheduleThumbUpdate();
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
      scheduleThumbUpdate();
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
        fabricCanvas.defaultCursor = "default";
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
    const obj = fabricCanvas?.getActiveObject();
    if (!obj) return;
    if (obj.type === "i-text" || obj.type === "textbox" || obj.type === "text") {
      obj.set("fill", colorInput.value);
      fabricCanvas.renderAll();
    } else if (obj.type === "rect") {
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

  // Match surrounding text
  matchTextBtn.addEventListener("click", () => {
    const obj = fabricCanvas?.getActiveObject();
    if (!obj || (obj.type !== "i-text" && obj.type !== "textbox" && obj.type !== "text")) return;

    // Use the object's position to find the nearest PDF text
    const detected = detectNearestFont(obj.left ?? 0, obj.top ?? 0);
    if (!detected) return;

    obj.set("fontFamily", detected.fontFamily);
    obj.set("fontSize", detected.fontSize);
    obj.set("fill", detected.color);
    obj.set("fontWeight", detected.bold ? "bold" : "normal");
    obj.set("fontStyle", detected.italic ? "italic" : "normal");

    // Ensure the detected font is in the dropdown
    if (!fontFamilySelect.querySelector(`option[value="${detected.fontFamily}"]`)) {
      const opt = document.createElement("option");
      opt.value = detected.fontFamily;
      opt.textContent = detected.fontFamily;
      fontFamilySelect.appendChild(opt);
    }

    // Update UI controls
    fontFamilySelect.value = detected.fontFamily;
    fontInput.value = String(Math.round(detected.fontSize));
    colorInput.value = detected.color;
    colorHex.textContent = detected.color;
    boldBtn.classList.toggle("active", detected.bold);
    italicBtn.classList.toggle("active", detected.italic);

    fabricCanvas.renderAll();
  });


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
    if (currentPage > 1) { saveCurrentAnnotations(); currentPage--; renderPage(); }
  });
  nextBtn.addEventListener("click", () => {
    if (currentPage < totalPages) { saveCurrentAnnotations(); currentPage++; renderPage(); }
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
  // Hides text-edit objects so they don't bake into the image overlay.
  async function capturePageAnnotations(): Promise<Map<number, string>> {
    const captures = new Map<number, string>();
    const origPage = currentPage;
    saveCurrentAnnotations();

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const annotJson = pageAnnotations.get(pageNum);
      if (!annotJson) continue;
      const parsed = JSON.parse(annotJson);
      if (!parsed.objects || parsed.objects.length === 0) continue;

      // Check if this page has only text-edit objects (no regular annotations)
      const hasNonEditObjects = parsed.objects.some((o: any) => !o._pdeTextEditId);
      if (!hasNonEditObjects) continue;

      // Navigate to the page to load its annotations on the live canvas
      currentPage = pageNum;
      await renderPage();
      // Wait a tick for fabric to finish rendering
      await new Promise(r => setTimeout(r, 50));

      // Temporarily hide text-edit objects before capture
      const hiddenObjs: any[] = [];
      for (const obj of fabricCanvas.getObjects()) {
        if (obj._pdeTextEditId) {
          obj.set("visible", false);
          hiddenObjs.push(obj);
        }
      }
      fabricCanvas.renderAll();

      // Capture the fabric canvas (annotations only, transparent bg)
      const dataUrl = fabricCanvas.toDataURL({ format: "png", multiplier: 1 });
      captures.set(pageNum, dataUrl);

      // Restore visibility
      for (const obj of hiddenObjs) obj.set("visible", true);
      fabricCanvas.renderAll();
    }

    // Restore original page
    currentPage = origPage;
    await renderPage();
    return captures;
  }

  /* ── Font mapping for pdf-lib export ── */
  function mapToStandardFont(family: string, bold: boolean, italic: boolean): string {
    const lower = family.toLowerCase();
    let base: string;
    if (lower.includes("courier") || lower.includes("consolas") || lower.includes("mono")) {
      base = "Courier";
    } else if (lower.includes("times") || lower.includes("georgia") || lower.includes("serif") ||
               lower.includes("palatino") || lower.includes("garamond") || lower.includes("cambria") ||
               lower.includes("book")) {
      base = "TimesRoman";
    } else {
      base = "Helvetica";
    }

    if (base === "Courier") {
      if (bold && italic) return "CourierBoldOblique";
      if (bold) return "CourierBold";
      if (italic) return "CourierOblique";
      return "Courier";
    }
    if (base === "TimesRoman") {
      if (bold && italic) return "TimesRomanBoldItalic";
      if (bold) return "TimesRomanBold";
      if (italic) return "TimesRomanItalic";
      return "TimesRoman";
    }
    // Helvetica
    if (bold && italic) return "HelveticaBoldOblique";
    if (bold) return "HelveticaBold";
    if (italic) return "HelveticaOblique";
    return "Helvetica";
  }

  /* ── Apply text edits to PDF content streams ── */
  async function applyTextEdits(outPdf: any, pdfLibModule: any) {
    const { PDFName, PDFArray, PDFRawStream } = pdfLibModule;
    const { removeTextFromStream } = await import("./pdf-content-stream");
    const pako = await import("pako");

    const pages = outPdf.getPages();

    for (const [pageNum, edits] of pageTextEdits) {
      if (!edits || edits.length === 0) continue;
      const pageIdx = pageNum - 1;
      if (pageIdx < 0 || pageIdx >= pages.length) continue;

      const page = pages[pageIdx];

      // Collect deletion edits (remove original text from content stream)
      const deleteEdits = edits.filter(e => e.deleted || e.newStr !== e.originalStr);

      if (deleteEdits.length > 0) {
        try {
          const pageNode = page.node;
          const contentsRef = pageNode.get(PDFName.of("Contents"));

          if (contentsRef) {
            // Collect all stream refs
            const streamRefs: any[] = [];
            if (contentsRef instanceof PDFArray) {
              for (let i = 0; i < contentsRef.size(); i++) {
                streamRefs.push(contentsRef.get(i));
              }
            } else {
              streamRefs.push(contentsRef);
            }

            for (const ref of streamRefs) {
              const streamObj = outPdf.context.lookup(ref);
              if (!streamObj) continue;

              // Get raw bytes from the stream (duck-typed for any pdf-lib stream)
              let streamBytes: Uint8Array;
              try {
                if (typeof streamObj.getContents === "function") {
                  streamBytes = streamObj.getContents();
                } else if (streamObj.contents) {
                  streamBytes = streamObj.contents;
                } else {
                  continue;
                }
              } catch {
                continue;
              }

              // Try to inflate if FlateDecode compressed
              let streamText: string;
              let wasCompressed = false;
              try {
                const inflated = pako.inflate(streamBytes);
                streamText = new TextDecoder("latin1").decode(inflated);
                wasCompressed = true;
              } catch {
                streamText = new TextDecoder("latin1").decode(streamBytes);
              }

              // Apply text removals
              const editPositions = deleteEdits.map(e => ({
                pdfX: e.pdfX,
                pdfY: e.pdfY,
                tolerance: 2.0,
                delete: true,
              }));

              const modified = removeTextFromStream(streamText, editPositions);
              if (modified === streamText) continue;

              // Re-encode
              const modifiedBytes = new Uint8Array(Array.from(modified, c => c.charCodeAt(0)));
              let finalBytes: Uint8Array;
              if (wasCompressed) {
                finalBytes = pako.deflate(modifiedBytes);
              } else {
                finalBytes = modifiedBytes;
              }

              // Replace the stream contents in the PDF
              // Modify the existing dict in-place to preserve all other keys
              const dict = streamObj.dict;
              dict.set(PDFName.of("Length"), outPdf.context.obj(finalBytes.length));
              if (wasCompressed) {
                dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
              } else {
                dict.delete(PDFName.of("Filter"));
              }
              const newStream = PDFRawStream.of(dict, finalBytes);
              outPdf.context.assign(ref, newStream);
            }
          }
        } catch (err) {
          console.warn(`[PDF Editor] Content stream edit failed for page ${pageNum}, using overlay fallback:`, err);
          // Fall through — replacement text will still be drawn, original may remain
        }
      }

      // Draw replacement text for edits that changed (not just deleted)
      const { StandardFonts } = pdfLibModule;
      const { rgb } = pdfLibModule;

      for (const edit of edits) {
        if (edit.deleted) continue;
        if (edit.newStr === edit.originalStr) continue;
        if (!edit.newStr) continue;

        try {
          const fontKey = mapToStandardFont(edit.detectedFamily, edit.bold, edit.italic);
          const font = await outPdf.embedFont(StandardFonts[fontKey] || StandardFonts.Helvetica);

          // Parse color
          let r = 0, g = 0, b = 0;
          if (edit.color.startsWith("#") && edit.color.length === 7) {
            r = parseInt(edit.color.slice(1, 3), 16) / 255;
            g = parseInt(edit.color.slice(3, 5), 16) / 255;
            b = parseInt(edit.color.slice(5, 7), 16) / 255;
          }

          page.drawText(edit.newStr, {
            x: edit.pdfX,
            y: edit.pdfY,
            size: edit.fontSizePt,
            font,
            color: rgb(r, g, b),
          });
        } catch (err) {
          console.warn(`[PDF Editor] Failed to draw replacement text for "${edit.newStr}":`, err);
        }
      }
    }
  }

  /* ── Download annotated PDF ── */
  downloadBtn.addEventListener("click", async () => {
    if (!pdfBytes || !pdfDoc) return;
    downloadBtn.classList.add("disabled");
    const dlLabel = downloadBtn.querySelector("span");
    if (dlLabel) dlLabel.textContent = "Exporting...";

    try {
      saveCurrentAnnotations();

      // Check if there are any text edits
      let hasTextEdits = false;
      for (const [, edits] of pageTextEdits) {
        if (edits.some(e => e.deleted || e.newStr !== e.originalStr)) {
          hasTextEdits = true;
          break;
        }
      }

      // Capture all annotated pages as PNGs (excluding text-edit objects)
      const captures = await capturePageAnnotations();

      if (captures.size === 0 && !hasTextEdits) {
        // No annotations and no text edits — just download the original
        const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = pdfFileName.replace(/\.pdf$/i, "") + "-edited.pdf";
        a.click();
        URL.revokeObjectURL(a.href);
        return;
      }

      const pdfLibModule = await import("pdf-lib");
      const { PDFDocument } = pdfLibModule;
      const outPdf = await PDFDocument.load(pdfBytes);

      // Apply text edits to content streams
      if (hasTextEdits) {
        await applyTextEdits(outPdf, pdfLibModule);
      }

      // Composite PNG overlays for non-text annotations
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

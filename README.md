# [Convert.it](https://convert.utoggl.in/)

**A truly universal file converter and toolkit that runs entirely in your browser.**

Most online converters are limited, insecure, and boring. They only handle conversions within the same media type and force you to upload your files to some random server. Convert.it is different — it processes everything locally using WebAssembly and on-device AI, supports cross-medium conversions, and packs a full suite of creative tools without ever touching a server.

Need to turn an AVI into a PDF? Extract text from a scanned document? Generate speech from text? Edit a PDF? Go for it.

---

## Tools

### Convert — Universal File Converter
Convert between **200+ file formats** across every media type. Images, video, audio, documents, archives, fonts, 3D models, game assets, and more.

- Auto-detects input format, pick your output and hit convert
- Batch conversion with automatic category detection and queueing
- Simple mode for everyday use, Advanced mode for power users
- Apply settings to all files at once
- Archive multi-file output as ZIP automatically

### Compress — Video Compression
Re-encode videos with quality control and target file size constraints.

- **Codecs:** H.264, H.265, VP9 (WebM)
- **Speed presets:** Fast, Balanced, Quality
- **Size presets:** Discord (10 / 50 / 500 MB), Twitter/X (15 / 512 MB), or custom
- **Output:** MP4 or WebM

### Image Tools
Professional image manipulation with AI-powered background removal.

- **Background Removal:** On-device via RMBG-1.4 (WebGPU/WASM) or remove.bg API
  - Correction mode preserves text and fine details
  - Before/after comparison toggle
- **Rescaling:** Custom dimensions with aspect ratio lock
- **Metadata Stripping:** Remove all EXIF data from images

### Video Editor
Full-featured in-browser video editing with timeline-based control.

- **Trim:** Drag timeline handles or type precise timestamps (HH:MM:SS.ms)
- **Crop:** Visual crop tool with pixel-precise positioning
- **Audio:**
  - Remove audio track entirely
  - 5-band parametric equalizer (60 Hz, 230 Hz, 910 Hz, 3.6 kHz, 14 kHz) with ±12 dB gain per band
- **Subtitles:**
  - Extract existing subtitles to SRT, ASS, VTT, or SSA
  - Remove subtitles from video
  - Mux subtitles as a selectable track
  - Burn subtitles directly onto the video
  - **AI subtitle generation** — Whisper-powered with 4 model sizes:
    - Base (75 MB) — fastest
    - Small (250 MB) — fast
    - Medium (1 GB) — balanced
    - Large V3 Turbo (1.5 GB) — best quality
  - 15 languages: English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Japanese, Korean, Chinese, Arabic, Hindi, Polish, Swedish — plus auto-detect
- **Merge:** Combine multiple videos with optional re-encode for codec compatibility
- **Privacy mode:** Strips all metadata from output
- **Codecs:** H.264 (MP4), VP9 (WebM), with hardware-accelerated WebCodecs where available
- **Output:** MP4, WebM, MKV

### Text & Speech
Text-to-speech and speech-to-text powered by on-device AI.

- **Text-to-Speech (Kokoro 82M — ~92 MB model)**
  - 28 neural voices across 4 categories:
    - **American Female (11):** Heart, Alloy, Aoede, Bella, Jessica, Kore, Nicole, Nova, River, Sarah, Sky
    - **American Male (9):** Adam, Echo, Eric, Fenrir, Liam, Michael, Onyx, Puck, Santa
    - **British Female (4):** Alice, Emma, Isabella, Lily
    - **British Male (4):** Daniel, Fable, George, Lewis
  - Speed control: 0.5x – 2.0x (0.1x steps)
  - Intelligent sentence chunking (300 char max per chunk) for natural pacing
  - Fullscreen read-aloud mode:
    - Word-by-word highlighting in the main text display
    - Sentence teleprompter with active word tracking
    - Transport controls: skip back, play/pause, skip forward
    - Full seek bar for precise navigation
    - "Try Another" to return and change text
  - Download generated audio as WAV

- **Speech-to-Text (Whisper)**
  - 4 model sizes:
    - Base (~75 MB) — fastest, good for clear audio
    - Small (~250 MB) — fast, better accuracy
    - Medium (~1 GB) — balanced quality and speed
    - Large V3 Turbo (~1.5 GB) — best accuracy
  - 15 languages: English, Spanish, French, German, Italian, Portuguese, Dutch, Russian, Japanese, Korean, Chinese, Arabic, Hindi, Polish, Swedish — plus auto-detect
  - Record directly from microphone or upload audio/video files
  - Word-level timestamps for precise transcription

### Summarize
AI-powered document and web page summarization.

- **Input sources:**
  - Upload files: PDF, DOCX, TXT, MD, CSV, JSON, XML, HTML, LOG, YAML, TOML, INI, CFG, CONF
  - Paste raw text (minimum 20 characters)
  - Enter a URL — automatically fetches and extracts page content (with CORS proxy fallback)
- **Models:**
  - DistilBART 6-6 (~300 MB) — fast
  - DistilBART 12-6 (~600 MB) — balanced (default)
  - BART Large CNN (~1.6 GB) — best quality
- **Target length:** 50 – 500 words (default: 150)
- **Smart chunking:** Documents over 1,200 words are split into 1,000-word chunks and summarized in parts, then combined
- PDF text extraction via pdfjs-dist, DOCX parsing via JSZip

### OCR — Text Extraction
Extract text from images and scanned PDFs using Tesseract.js (WASM).

- **14 languages:** English, Spanish, French, German, Italian, Portuguese, Russian, Japanese, Korean, Chinese (Simplified), Chinese (Traditional), Arabic, Hindi, Polish
- Language data downloaded on demand (~15 MB per language, cached after first use)
- Multi-page PDF support with live page preview (rendered at 2x scale for OCR accuracy)
- Single image or batch processing
- **Fullscreen read-aloud mode:**
  - Generates speech from extracted text using Kokoro TTS
  - Word-by-word highlighting in the main text display
  - Sentence teleprompter with active word tracking
  - Transport controls and seek bar
  - Download generated audio as WAV
  - "Try Another" button to return and process a new file
- Copy or download results as plain text

### PDF Editor
Annotate, sign, and edit PDFs directly in the browser.

- **6 tools:**
  - **Select** — move, resize, and manipulate placed objects
  - **Text** — add editable text boxes with full styling:
    - 20 fonts: Arial, Book Antiqua, Bookman Old Style, Calibri, Cambria, Comic Sans MS, Consolas, Courier New, Garamond, Georgia, Helvetica, Impact, Lucida Console, Lucida Sans Unicode, Palatino Linotype, Segoe UI, Tahoma, Times New Roman, Trebuchet MS, Verdana
    - Font size: 8 – 120 px
    - Bold, italic, underline, strikethrough
    - Text alignment: left, center, right
    - Bullet points with auto-formatting
    - **"Match Surrounding Text"** — samples the PDF at click position to auto-detect font family, size, color, and bold/italic style (uses 5×5 pixel grid color sampling with brightness thresholds)
  - **Draw** — freehand pencil brush (1 – 20 px) with color picker and opacity control (0 – 100%)
  - **Highlight** — semi-transparent rectangle overlays (35% opacity)
  - **Erase** — fills areas with a sampled background color (eyedropper picks from the PDF surface)
  - **Image** — insert and scale images for stamps and signatures (auto-scales if larger than half the canvas)
- **Page navigation** with live thumbnail sidebar (150px width, updates in real time as you edit)
- **Zoom:** 25% – 300% in 25% steps
- **Undo/Redo** per page (50-action stack)
- Multi-page PDF support with per-page annotation persistence
- Export composites annotations as PNG overlays embedded via pdf-lib, saved as "-edited.pdf"

---

## Supported Formats

| Category | Examples |
|---|---|
| Image | PNG, JPEG, WebP, GIF, SVG, TIFF, BMP, ICO, HEIF, AVIF, JP2, JXL, QOI, VTF, Aseprite, and 50+ more |
| Video | MP4, AVI, MKV, WebM, MOV, FLV, and 100+ FFmpeg formats |
| Audio | MP3, WAV, OGG, FLAC, AAC, MIDI, MOD, XM, S3M, IT, QOA, and more |
| Document | PDF, DOCX, XLSX, PPTX, HTML, Markdown, EPUB, RTF, LaTeX, ODT, and 50+ via Pandoc |
| Data | JSON, XML, YAML, CSV, SQL, SQLite, NBT (Minecraft) |
| Archive | ZIP, 7Z, TAR, TAR.GZ, GZ, LZH |
| 3D Model | GLB and other formats via Three.js |
| Font | TTF, OTF, WOFF, WOFF2 |
| Game | Doom WAD, Beat Saber replays (BSOR), Scratch 3.0 (SB3), Portal 2 (SPPD), Half-Life 2 (VTF) |
| Other | Base64, hex, URL encoding, Python turtle graphics, PE executables |

---

## Privacy & Security

- **100% client-side** — all processing runs in your browser using WebAssembly
- **Your files never leave your device** — unless you explicitly opt into remove.bg API or CORS proxy
- **Privacy mode** — strips EXIF/GPS metadata, randomizes filenames, and hides referrer headers
- **No accounts, no tracking, no uploads**

---

## Personalization

- Dark and light themes
- 8 preset accent colors + 3 custom color slots with full color picker
- Configurable defaults for every tool (voices, models, languages, codecs, brush sizes, and more)
- Auto-download toggle or collect files in the output tray

---

## Tech Stack

- **TypeScript** + **Vite** — fast builds, modern tooling
- **FFmpeg WASM** — video/audio transcoding
- **ImageMagick WASM** — 100+ image formats
- **Pandoc** — 50+ document formats
- **Tesseract.js** — OCR text extraction
- **Kokoro TTS** — neural text-to-speech (82M parameters)
- **Whisper** (Transformers.js) — speech-to-text and subtitle generation
- **DistilBART / BART** (Transformers.js) — text summarization
- **RMBG-1.4** (Transformers.js) — AI background removal
- **pdfjs-dist** + **Fabric.js** + **pdf-lib** — PDF rendering, annotation, and export
- **Three.js** — 3D model conversion
- **7z-WASM**, **JSZip**, **pako** — archive handling
- **libopenmpt** — music tracker format playback

---

## Usage

1. Go to [convert.utoggl.in](https://convert.utoggl.in/)
2. Pick a tool from the home screen or drop files anywhere
3. Configure your options and hit the action button
4. Download your result — or keep working

---

## License

GPL-2.0

---

This project is a fork of [**Convert**](https://github.com/p2r3/convert) by [p2r3](https://github.com/p2r3) — the original truly universal file converter.

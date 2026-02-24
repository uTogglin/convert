# [Convert.it](https://convert.utoggl.in/)

**A truly universal file converter that runs entirely in your browser.**

Most online converters are limited, insecure, and boring. They only handle conversions within the same media type and force you to upload your files to some random server. Convert.it is different — it processes everything locally, supports cross-medium conversions, and handles hundreds of formats without ever touching a server.

Need to turn an AVI into a PDF? A MIDI file into a WAV? A 3D model into an image? Go for it.

## Features

- **Hundreds of formats** — Images, video, audio, documents, 3D models, fonts, archives, spreadsheets, presentations, and more
- **100% browser-based** — Your files never leave your machine (unless you opt into API features)
- **Cross-medium conversion** — Convert between completely different media types, not just within the same category
- **Background removal** — Local AI-powered (RMBG-1.4 via WebGPU/WASM) or remove.bg API, with optional correction mode for preserving text and fine details
- **Image rescaling** — Custom dimensions with aspect ratio lock
- **Compression** — Compress output to a target file size, with handy Discord presets (10/25/50 MB)
- **Privacy mode** — Strips EXIF/GPS metadata, randomizes filenames, and hides referrer headers
- **Archive creation** — Bundle files into .zip, .7z, .tar, .tar.gz, or .gz
- **Output tray** — Preview converted files, drag them out, or download individually or all at once
- **Auto-download** — Toggle automatic downloads or collect files in the output tray
- **Dark/light theme** — With 8 preset accent colors and 3 custom color slots
- **Advanced mode** — Unlocks additional format options for power users

## Supported Categories

| Category | Examples |
|---|---|
| Image | PNG, JPEG, WebP, GIF, SVG, QOI, VTF, Aseprite, and many more |
| Video | MP4, AVI, MKV, WebM, MOV, and more via FFmpeg |
| Audio | MP3, WAV, OGG, FLAC, QOA, MIDI, tracker formats via libopenmpt |
| Document | PDF, DOCX, HTML, Markdown, and more via Pandoc |
| Data | JSON, XML, YAML, CSV, SQLite, NBT |
| Archive | ZIP, 7z, TAR, GZ, LZH |
| 3D Model | Various formats via Three.js |
| Font | TTF, OTF, WOFF, WOFF2 |
| Spreadsheet | XLSX |
| Presentation | PPTX |

## Usage

1. Go to [convert.utoggl.in](https://convert.utoggl.in/)
2. Click the drop zone or drag and drop your file
3. The input format is auto-detected — select your desired output format
4. Click **Convert**
5. Download your file from the output tray

## Tech Stack

- **TypeScript** + **Vite**
- **FFmpeg** (WASM) for audio/video
- **ImageMagick** (WASM) for image processing
- **Three.js** for 3D model conversion
- **Pandoc** for document conversion
- **Hugging Face Transformers** for AI-powered background removal
- **7z-WASM**, **JSZip**, **pako** for archive handling

## License

GPL-2.0

---

This project is a fork of [**Convert**](https://github.com/p2r3/convert) by [p2r3](https://github.com/p2r3) — the original truly universal file converter.

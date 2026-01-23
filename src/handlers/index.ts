import type { FormatHandler } from "../FormatHandler.ts";

import canvasToBlobHandler from "./canvasToBlob.ts";
import FFmpegHandler from "./FFmpeg.ts";
import pdftoimgHandler from "./pdftoimg.ts";
import ImageMagickHandler from "./ImageMagick.ts";
import renameHandler from "./rename.ts";
import envelopeHandler from "./envelope.ts";
import svgForeignObjectHandler from "./svgForeignObject.ts";

const handlers: FormatHandler[] = [
  new canvasToBlobHandler(),
  new FFmpegHandler(),
  new pdftoimgHandler(),
  new ImageMagickHandler(),
  new renameHandler(),
  new envelopeHandler(),
  new svgForeignObjectHandler(),
];
export default handlers;

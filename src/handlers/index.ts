import type { FormatHandler } from "../FormatHandler.ts";

import canvasToBlobHandler from "./canvasToBlob.ts";
import meydaHandler from "./meyda.ts";
import FFmpegHandler from "./FFmpeg.ts";
import pdftoimgHandler from "./pdftoimg.ts";
import ImageMagickHandler from "./ImageMagick.ts";
import renameHandler from "./rename.ts";
import envelopeHandler from "./envelope.ts";
import svgForeignObjectHandler from "./svgForeignObject.ts";
import qoiFuHandler from "./qoi-fu.ts";
import sppdHandler from "./sppd.ts";
import threejsHandler from "./threejs.ts";

const handlers: FormatHandler[] = [
  new canvasToBlobHandler(),
  new meydaHandler(),
  new FFmpegHandler(),
  new pdftoimgHandler(),
  new ImageMagickHandler(),
  new renameHandler(),
  new envelopeHandler(),
  new svgForeignObjectHandler(),
  new qoiFuHandler(),
  new sppdHandler(),
  new threejsHandler(),
];
export default handlers;

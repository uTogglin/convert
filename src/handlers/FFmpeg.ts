import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { LogEvent } from "@ffmpeg/ffmpeg";
import mime from "mime";

console.log(mime.getType("docx"));
console.log(mime.getType("pptx"));
console.log(mime.getType("xlsx"));
console.log(mime.getType("odt"));
console.log(mime.getType("odp"));
console.log(mime.getType("ods"));

class FFmpegHandler implements FormatHandler {

  public name: string = "FFmpeg";
  public supportedFormats: FileFormat[] = [];
  public ready: boolean = false;

  #ffmpeg?: FFmpeg;

  #stdout: string = "";
  handleStdout (log: LogEvent) {
    this.#stdout += log.message + "\n";
  }
  clearStdout () {
    this.#stdout = "";
  }
  async getStdout (callback: () => void | Promise<void>) {
    if (!this.#ffmpeg) return "";
    this.clearStdout();
    this.#ffmpeg.on("log", this.handleStdout.bind(this));
    await callback();
    this.#ffmpeg.off("log", this.handleStdout.bind(this));
    return this.#stdout;
  }

  async init () {

    this.#ffmpeg = new FFmpeg();
    await this.#ffmpeg.load({
      coreURL: "/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js",
    });

    const getMuxerDetails = async (muxer: string) => {

      const stdout = await this.getStdout(async () => {
        await this.#ffmpeg!.exec(["-hide_banner", "-h", "muxer=" + muxer]);
      });

      return {
        extension: stdout.split("Common extensions: ")[1].split(".")[0].split(",")[0],
        mimeType: stdout.split("Mime type: ")[1].split(".")[0]
      };
    }

    const stdout = await this.getStdout(async () => {
      await this.#ffmpeg!.exec(["-formats", "-hide_banner"]);
    });
    const lines = stdout.split(" --\n")[1].split("\n");

    for (let line of lines) {

      let len;
      do {
        len = line.length;
        line = line.replaceAll("  ", " ");
      } while (len !== line.length);
      line = line.trim();

      const parts = line.split(" ");
      if (parts.length < 2) continue;

      const flags = parts[0];
      const description = parts.slice(2).join(" ");
      const formats = parts[1].split(",");

      for (const format of formats) {

        let primaryFormat = formats[0];
        if (primaryFormat === "png") primaryFormat = "apng";

        let extension, mimeType;
        try {
          const details = await getMuxerDetails(primaryFormat);
          extension = details.extension;
          mimeType = details.mimeType;
        } catch {
          extension = format;
          mimeType = mime.getType(format) || ("video/" + format);
        }

        this.supportedFormats.push({
          name: description + (formats.length > 1 ? (" / " + format) : ""),
          format,
          extension,
          mime: mimeType,
          from: flags.includes("D"),
          to: flags.includes("E"),
          internal: format
        });

      }

    }

    // ====== Manual fine-tuning ======

    const prioritize = ["webm", "mp4", "gif"];
    prioritize.reverse();

    this.supportedFormats.sort((a, b) => {
      const priorityIndexA = prioritize.indexOf(a.format);
      const priorityIndexB = prioritize.indexOf(b.format);
      return priorityIndexB - priorityIndexA;
    });

    // AV1 doesn't seem to be included in WASM FFmpeg
    this.supportedFormats.splice(this.supportedFormats.findIndex(c => c.mime === "image/avif"), 1);

    this.#ffmpeg.terminate();

    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
    args?: string[]
  ): Promise<FileData[]> {

    if (!this.#ffmpeg) {
      throw "Handler not initialized.";
    }

    await this.#ffmpeg.load();

    for (const file of inputFiles) {
      await this.#ffmpeg.writeFile(file.name, new Uint8Array(file.bytes));
    }
    const listString = inputFiles.map(f => `file '${f.name}'`).join("\n");
    await this.#ffmpeg.writeFile("list.txt", new TextEncoder().encode(listString));

    const command = ["-hide_banner", "-f", "concat", "-safe", "0", "-i", "list.txt", "-f", outputFormat.internal];
    if (inputFormat.format === "png" || inputFormat.mime === "image/jpeg") {
      command.push("-r", "1");
    }
    if (args) command.push(...args);
    command.push("output");

    const stdout = await this.getStdout(async () => {
      await this.#ffmpeg!.exec(command);
    });

    for (const file of inputFiles) {
      await this.#ffmpeg.deleteFile(file.name);
    }

    if (stdout.includes("Conversion failed!\n")) {

      if (!args) {
        if (stdout.includes("Valid sizes are")) {
          const newSize = stdout.split("Valid sizes are ")[1].split(".")[0].split(" ").pop();
          if (typeof newSize !== "string") throw stdout;
          return this.doConvert(inputFiles, inputFormat, outputFormat, ["-s", newSize]);
        }
      }

      throw stdout;
    }

    let bytes: Uint8Array;

    const fileData = await this.#ffmpeg.readFile("output");
    if (!(fileData instanceof Uint8Array)) {
      const encoder = new TextEncoder();
      bytes = encoder.encode(fileData);
    } else {
      bytes = new Uint8Array(fileData?.buffer);
    }

    await this.#ffmpeg.deleteFile("output");
    this.#ffmpeg.terminate();

    const baseName = inputFiles[0].name.split(".")[0];
    const name = baseName + "." + outputFormat.extension;

    return [{ bytes, name }];

  }

}

export default FFmpegHandler;

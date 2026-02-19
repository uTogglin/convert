// file: ani.ts

import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats from "src/CommonFormats.ts";

class aniHandler implements FormatHandler {

    public name: string = "ani";
    public supportedFormats?: FileFormat[];
    public ready: boolean = false;

    async init () {
        this.supportedFormats = [
            {
                name: "Microsoft Windows ICO",
                format: "ico",
                extension: "ico",
                mime: "image/vnd.microsoft.icon",
                from: true,
                to: true,
                internal: "ico",
                category: "image",
                lossless: false,
            },
            {
                name: "Microsoft Windows ANI",
                format: "ani",
                extension: "ani",
                mime: "application/x-navi-animation",
                from: true,
                to: true,
                internal: "ani",
                category: "image",
                lossless: false,
            }
        ];
        this.ready = true;
    }

    async doConvert (
        inputFiles: FileData[],
        inputFormat: FileFormat,
        outputFormat: FileFormat
    ): Promise<FileData[]> {
        const outputFiles: FileData[] = [];

        for (const file of inputFiles) {
            outputFiles.push({
                name: file.name,
                bytes: inputFiles.bytes
            })
        }
        return outputFiles;
    }
}

export default aniHandler;
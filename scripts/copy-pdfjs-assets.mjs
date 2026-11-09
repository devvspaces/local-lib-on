// Copies runtime assets into public/ so they're served offline:
//   pdf.js CMaps, standard fonts, wasm decoders · tesseract.js worker, wasm core, English traineddata.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
const pdf = "node_modules/pdfjs-dist";
mkdirSync("public/pdfjs", { recursive: true });
for (const d of ["cmaps", "standard_fonts", "wasm"]) cpSync(`${pdf}/${d}`, `public/pdfjs/${d}`, { recursive: true });
cpSync(`${pdf}/web/images`, "public/pdfjs/images", { recursive: true });

mkdirSync("public/tesseract/core", { recursive: true });
mkdirSync("public/tesseract/lang", { recursive: true });
cpSync("node_modules/tesseract.js/dist/worker.min.js", "public/tesseract/worker.min.js");
for (const f of readdirSync("node_modules/tesseract.js-core")) if (/^tesseract-core(-simd)?-lstm\.(js|wasm|wasm\.js)$/.test(f)) cpSync(`node_modules/tesseract.js-core/${f}`, `public/tesseract/core/${f}`);
cpSync("node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "public/tesseract/lang/eng.traineddata.gz");
console.log("pdf.js + tesseract assets copied to public/");

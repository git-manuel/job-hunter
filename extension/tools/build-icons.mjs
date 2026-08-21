import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, "..", "icons", "source", "icon.svg");
const outDir = path.join(__dirname, "..", "icons");
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const outPath = path.join(outDir, `icon${size}.png`);
  await sharp(src, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(outPath);
  console.log(`wrote ${outPath}`);
}

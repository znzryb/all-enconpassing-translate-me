/**
 * Renders assets/icon.svg into the PNG sizes Chrome asks for.
 * Run with `pnpm icons` after editing the SVG.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'assets/icon.svg'));
const outDir = resolve(root, 'public/icon');
await mkdir(outDir, { recursive: true });

const SIZES = [16, 32, 48, 96, 128];

for (const size of SIZES) {
  const png = await sharp(source, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await writeFile(resolve(outDir, `${size}.png`), png);
  console.log(`icon/${size}.png  ${png.length} bytes`);
}

/**
 * Copies the built extension to the directory Chrome loads unpacked from.
 *
 * The build output lives in the repo, but Chrome holds an absolute path to
 * wherever the extension was first loaded from. Keeping that a stable location
 * outside the repo means "Reload" in chrome://extensions always picks up the
 * newest build instead of a stale copy.
 */
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, '.output/chrome-mv3');
const target = resolve(homedir(), 'chrome-extensions/all-encompassing-translate-me');

try {
  await stat(resolve(source, 'manifest.json'));
} catch {
  console.error(`No build found at ${source}. Run "pnpm build" first.`);
  process.exit(1);
}

// Only ever replace a directory that is this extension, never anything else.
try {
  const existing = JSON.parse(await readFile(resolve(target, 'manifest.json'), 'utf8'));
  if (existing.name !== JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8')).name) {
    console.error(`Refusing to overwrite ${target}: it holds a different extension.`);
    process.exit(1);
  }
  await rm(target, { recursive: true });
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

console.log(`Installed to ${target}`);
console.log('Now open chrome://extensions and press Reload (or Load unpacked on first install).');

import { build } from 'vite';
import { copyFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const requested = process.argv[2] || 'all';
if (!['all', 'offline', 'web'].includes(requested) || process.argv.length > 3) {
  throw new Error('Usage: node scripts/build.mjs [offline|web]');
}

function inside(root, path) {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child);
}

async function prepareOutput(name) {
  const output = resolve(projectRoot, name);
  await mkdir(output, { recursive: true });
  const actual = await realpath(output);
  if (!inside(projectRoot, actual) || actual !== output) {
    throw new Error(`Refusing to empty a redirected build directory: ${output}`);
  }
  return output;
}

for (const variant of requested === 'all' ? ['offline', 'web'] : [requested]) {
  const output = await prepareOutput(variant === 'web' ? 'dist-web' : 'dist');
  await build({
    root: projectRoot,
    configFile: resolve(projectRoot, 'vite.config.js'),
    configLoader: 'native',
    mode: variant,
    build: { outDir: output, emptyOutDir: true }
  });
  const html = await readFile(resolve(output, 'index.html'), 'utf8');
  if (variant === 'offline') {
    if (!/data:audio\/[^;,]+;base64,/.test(html)) throw new Error('The offline build must embed its audio.');
    await copyFile(resolve(output, 'index.html'), resolve(projectRoot, 'jacaranda-corner.html'));
    console.log('Offline page updated: jacaranda-corner.html');
  } else {
    if (/data:audio\/[^;,]+;base64,/.test(html)) throw new Error('The web build must not embed audio.');
    const tracks = (await readdir(output)).filter(name => name.endsWith('.mp3'));
    if (!tracks.length || tracks.some(name => !html.includes(name))) throw new Error('The web build is missing a referenced MP3.');
    console.log(`Web page ready: dist-web/index.html + ${tracks.join(', ')}`);
  }
}

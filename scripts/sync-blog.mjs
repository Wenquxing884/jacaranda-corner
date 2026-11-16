import { copyFile, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [blogArgument, ...extra] = process.argv.slice(2);
if (!blogArgument || extra.length) throw new Error('Usage: npm run sync:blog -- ../blog');

function assertInside(root, path, label) {
  const child = relative(root, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} must stay inside ${root}`);
  }
}

async function assertWritableFile(path, root) {
  assertInside(root, path, 'Destination');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to overwrite a redirected or non-file destination: ${path}`);
    assertInside(root, await realpath(path), 'Resolved destination');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Read attributes only from this element's opening tag. Scanning a complete
// anchor would also find attributes in later elements or inline JS strings.
function attribute(openingTag, name) {
  const attributes = openingTag.replace(/^<[\w:-]+\b/, '').replace(/\/?>$/, '');
  for (const match of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    if (match[1].toLowerCase() === name.toLowerCase()) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return undefined;
}

function integrationFragments(html) {
  const canonical = [...html.matchAll(/<link\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)]
    .map(match => match[0]).filter(tag => attribute(tag, 'rel')?.toLowerCase() === 'canonical');
  const backLinks = [];
  // Select the actual opening tag first, then find only its closing anchor.
  // Three.js contains '<a' strings; unrelated anchors must never consume the
  // scripts and everything up to the real back-to-blog element.
  for (const match of html.matchAll(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const opening = match[0];
    if (!attribute(opening, 'class')?.split(/\s+/).includes('back-to-blog')) continue;
    const remaining = html.slice(match.index + opening.length);
    const closing = /<\/a\s*>/i.exec(remaining);
    if (!closing || closing.index > 4096 || /<\/?(?:a|script|style|body|html)\b/i.test(remaining.slice(0, closing.index))) {
      throw new Error('The existing back-to-blog anchor is malformed or contains unexpected page content.');
    }
    backLinks.push({ opening, html: opening + remaining.slice(0, closing.index + closing[0].length) });
  }
  return { canonical, backLinks };
}

const sourceRoot = await realpath(resolve(projectRoot, 'dist-web'));
assertInside(projectRoot, sourceRoot, 'Web build');
const sourceHtml = resolve(sourceRoot, 'index.html');
const blogRoot = await realpath(resolve(process.cwd(), blogArgument));
const targetRoot = await realpath(resolve(blogRoot, 'games', 'jacaranda-corner'));
assertInside(blogRoot, targetRoot, 'Blog route');
const targetHtml = resolve(targetRoot, 'index.html');
await assertWritableFile(targetHtml, targetRoot);

const [built, old] = await Promise.all([readFile(sourceHtml, 'utf8'), readFile(targetHtml, 'utf8')]);
if (/data:audio\/[^;,]+;base64,/.test(built)) throw new Error('dist-web contains embedded audio. Run npm run build:web first.');
const { canonical, backLinks } = integrationFragments(old);
if (canonical.length !== 1 || backLinks.length !== 1) throw new Error('The existing blog page must have exactly one canonical and one back-to-blog link.');
if (attribute(backLinks[0].opening, 'href') !== '../../index.html') throw new Error('The existing blog return link has an unexpected destination.');
if (!/^https?:\/\//i.test(attribute(canonical[0], 'href') || '')) throw new Error('The canonical URL must be an existing HTTP(S) address.');
const sourceFragments = integrationFragments(built);
if (sourceFragments.canonical.length || sourceFragments.backLinks.length) {
  throw new Error('The build already contains blog-specific integration; refusing to duplicate it.');
}
if ([...built.matchAll(/<title\b[^>]*>/gi)].length !== 1 || [...built.matchAll(/<body\b[^>]*>/gi)].length !== 1) {
  throw new Error('The build must contain exactly one title and one body.');
}

const rootFiles = await readdir(sourceRoot, { withFileTypes: true });
const tracks = rootFiles.filter(entry => entry.isFile() && /^[A-Za-z0-9._-]+\.mp3$/i.test(entry.name) && built.includes(entry.name));
if (!tracks.length) throw new Error('No external MP3 referenced by the web build was found.');
for (const entry of tracks) {
  const source = resolve(sourceRoot, entry.name), destination = resolve(targetRoot, entry.name);
  assertInside(sourceRoot, await realpath(source), 'Audio source');
  await assertWritableFile(destination, targetRoot);
}

if (canonical[0].length > 2048 || backLinks[0].html.length > 8192) throw new Error('The blog integration fragments exceed their expected size.');
const canonicalInsertion = `${canonical[0]}\n    `;
const backInsertion = `\n    ${backLinks[0].html}`;
const page = built
  .replace(/<title\b/i, () => `${canonicalInsertion}<title`)
  .replace(/<body\b[^>]*>/i, tag => `${tag}${backInsertion}`);
const expectedBytes = Buffer.byteLength(built) + Buffer.byteLength(canonicalInsertion) + Buffer.byteLength(backInsertion);
if (Buffer.byteLength(page) !== expectedBytes || page.replace(canonicalInsertion, '').replace(backInsertion, '') !== built) {
  throw new Error('The blog page must differ from the build only by the two integration fragments.');
}
if (/data:audio\/[^;,]+;base64,/i.test(page)) throw new Error('Refusing to sync a web page containing inline audio.');
const resultFragments = integrationFragments(page);
if (resultFragments.canonical.length !== 1 || resultFragments.backLinks.length !== 1) {
  throw new Error('The final page must contain exactly one of each blog integration fragment.');
}

// Copy assets before exposing the new HTML. Existing unrelated files and old
// hashed assets stay untouched, so previously cached pages remain usable.
for (const entry of tracks) await copyFile(resolve(sourceRoot, entry.name), resolve(targetRoot, entry.name));
await writeFile(targetHtml, page, 'utf8');
if (await readFile(targetHtml, 'utf8') !== page) throw new Error('The synced HTML failed verification.');
for (const entry of tracks) {
  const [source, copied] = await Promise.all([readFile(resolve(sourceRoot, entry.name)), readFile(resolve(targetRoot, entry.name))]);
  if (!source.equals(copied)) throw new Error(`The copied audio failed verification: ${entry.name}`);
}
console.log(JSON.stringify({
  destination: targetHtml,
  htmlBytes: Buffer.byteLength(page),
  audioFiles: tracks.map(entry => entry.name),
  preserved: ['canonical', 'back-to-blog'],
  deletedFiles: 0
}, null, 2));

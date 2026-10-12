// Erzeugt src/lib/ui/icons/sprite.ts aus den Lucide-Icons in @lucide/svelte.
// Grund: In virtuellen Listen entstehen beim Scrollen ständig Zeilen neu. Eine
// Lucide-Komponente pro Icon ist dort zu teuer, <svg><use href="#i-…"/></svg> kostet fast nichts.
// Aufruf: npm run icons
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ICON_DIR = join(root, 'node_modules/@lucide/svelte/dist/icons');
export const OUTPUT_FILE = join(root, 'src/lib/ui/icons/sprite.ts');

// Icons, die in Listenzeilen und Leisten vorkommen. Zuordnung laut DESIGN-SYSTEM.md.
export const ICONS = [
  'folder',
  'folder-open',
  'file',
  'file-archive',
  'file-text',
  'file-lock',
  'database',
  'server',
  'cloud',
  'check',
  'minus',
  'chevron-right',
  'chevron-up',
  'chevron-down',
  'arrow-up',
  'arrow-down',
  'pause',
  'play',
  'x',
  'rotate-cw',
  'loader',
  'circle-check',
  'circle-x',
  'circle-alert',
  'triangle-alert',
  'clipboard-copy',
  'copy',
  'pencil',
  'history',
  'link',
  'download',
  'upload',
  'scissors',
  'clipboard-paste',
  'trash-2',
  'folder-plus',
  'refresh-cw',
  'plug',
  'unplug',
  'plus',
  'panel-right',
];

const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Liest die Lucide-Komponente; Aliase (nur .js mit Re-Export) werden aufgelöst. */
export function readIconSource(name, iconDir = ICON_DIR) {
  const svelteFile = join(iconDir, `${name}.svelte`);
  if (existsSync(svelteFile)) return readFileSync(svelteFile, 'utf8');
  const js = readFileSync(join(iconDir, `${name}.js`), 'utf8');
  const target = js.match(/from "\.\/(.+?)\.svelte"/);
  if (!target) throw new Error(`Icon ${name} nicht auflösbar`);
  return readFileSync(join(iconDir, `${target[1]}.svelte`), 'utf8');
}

/** Wandelt die Quelle einer Lucide-Komponente in ein <symbol>. */
export function toSymbol(name, source) {
  const match = source.match(/const iconData = (\{.*\});/);
  if (!match) throw new Error(`Icon-Daten für ${name} nicht gefunden`);
  const data = JSON.parse(match[1]);
  const children = data.node
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
          .join(' ')}/>`,
    )
    .join('');
  return `<symbol id="i-${name}" viewBox="0 0 24 24">${children}</symbol>`;
}

/** Inhalt von sprite.ts für die gegebenen Icons. */
export function buildSpriteModule(names, readSource = readIconSource) {
  const symbols = names.map((name) => toSymbol(name, readSource(name)));
  return `// Automatisch erzeugt von scripts/gen-icon-sprite.mjs – nicht von Hand bearbeiten.
// Lucide Icons, ISC-Lizenz.
export type SpriteIconName =
${names.map((n) => `  | '${n}'`).join('\n')};

export const SPRITE_SVG = ${JSON.stringify(symbols.join(''))};
`;
}

function main() {
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, buildSpriteModule(ICONS));
  console.log(`sprite.ts mit ${ICONS.length} Icons geschrieben`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpriteModule, ICONS, readIconSource, toSymbol } from './gen-icon-sprite.mjs';

const component = (node) => `<script>const iconData = ${JSON.stringify({ name: 'x', size: 24, node })};</script>`;

describe('gen-icon-sprite', () => {
  it('wandelt Icon-Daten in ein Symbol und maskiert Attribute', () => {
    const symbol = toSymbol(
      'demo',
      component([
        ['path', { d: 'M1 1"&<' }],
        ['circle', { cx: '12', r: '3' }],
      ]),
    );
    expect(symbol).toBe(
      '<symbol id="i-demo" viewBox="0 0 24 24"><path d="M1 1&quot;&amp;&lt;"/><circle cx="12" r="3"/></symbol>',
    );
  });

  it('meldet fehlende Icon-Daten', () => {
    expect(() => toSymbol('kaputt', '<script></script>')).toThrow('kaputt');
  });

  it('löst Aliase auf und meldet unauflösbare', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icons-'));
    writeFileSync(join(dir, 'echt.svelte'), component([['path', { d: 'M0 0' }]]));
    writeFileSync(join(dir, 'alias.js'), 'export { default } from "./echt.svelte";');
    writeFileSync(join(dir, 'kaputt.js'), 'export {};');
    expect(readIconSource('alias', dir)).toContain('M0 0');
    expect(readIconSource('echt', dir)).toContain('M0 0');
    expect(() => readIconSource('kaputt', dir)).toThrow('kaputt');
  });

  it('erzeugt ein Modul mit Typ und Sprite', () => {
    const out = buildSpriteModule(['a', 'b'], () => component([['path', { d: 'M0 0' }]]));
    expect(out).toContain("| 'a'");
    expect(out).toContain('export const SPRITE_SVG = "<symbol id=\\"i-a\\"');
  });

  it('findet alle konfigurierten Lucide-Icons', () => {
    expect(() => buildSpriteModule(ICONS)).not.toThrow();
  });
});

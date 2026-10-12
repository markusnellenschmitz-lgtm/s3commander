import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import SpriteIcon from './SpriteIcon.svelte';
import IconSprite from './IconSprite.svelte';

describe('SpriteIcon', () => {
  it('verweist auf das Symbol und ist ohne Label dekorativ', () => {
    const { container } = render(SpriteIcon, { name: 'folder', class: 'is-folder' });
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveClass('s3-ico', 'is-folder');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.querySelector('use')).toHaveAttribute('href', '#i-folder');
  });

  it('ist mit Label ein benanntes Bild', () => {
    const { getByRole } = render(SpriteIcon, { name: 'arrow-up', label: 'Upload' });
    expect(getByRole('img', { name: 'Upload' })).toBeInTheDocument();
  });
});

describe('IconSprite', () => {
  it('stellt die Symbole im SVG-Namensraum bereit', () => {
    const { container } = render(IconSprite);
    const symbol = container.querySelector('#i-folder')!;
    expect(symbol.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(symbol.querySelector('path')).toBeInTheDocument();
  });
});

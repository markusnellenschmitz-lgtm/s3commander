import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ContextMenu from './ContextMenu.svelte';
import { SEPARATOR, type MenuEntry } from '../../core/menu';
import type { SpriteIconName } from '../icons/sprite';

const entries: MenuEntry<string, SpriteIconName>[] = [
  { id: 'download', label: 'Herunterladen', icon: 'download', kbd: 'Strg+D' },
  SEPARATOR,
  { id: 'rename', label: 'Umbenennen', icon: 'pencil', kbd: 'F2', disabled: true },
  { id: 'delete', label: 'Löschen', icon: 'trash-2', danger: true },
];

function setup(x = 10, y = 20) {
  const onselect = vi.fn();
  const onclose = vi.fn();
  render(ContextMenu<string>, { entries, x, y, onselect, onclose });
  return { onselect, onclose, menu: screen.getByRole('menu', { name: 'Kontextmenü' }) };
}

describe('ContextMenu', () => {
  it('zeigt Einträge mit Kürzel, Trennlinie, Sperre und Gefahr und fokussiert den ersten', () => {
    const { menu } = setup();
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Herunterladen Strg+D',
      'Umbenennen F2',
      'Löschen',
    ]);
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
    expect(items[2]).toHaveClass('is-danger');
    expect(menu.querySelector('hr')).not.toBeNull();
    expect(items[0]).toHaveFocus();
    expect(menu.style.left).toBe('10px');
    expect(menu.style.top).toBe('20px');
  });

  it('wandert mit den Pfeiltasten über wählbare Einträge und wählt mit Klick', async () => {
    const { menu, onselect } = setup();
    const items = screen.getAllByRole('menuitem');
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[2]).toHaveFocus();
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    await fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(items[2]).toHaveFocus();
    await fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveFocus();
    await fireEvent.keyDown(menu, { key: 'End' });
    expect(items[2]).toHaveFocus();
    await fireEvent.keyDown(menu, { key: 'x' });
    await fireEvent.click(items[1]);
    expect(onselect).not.toHaveBeenCalled();
    await fireEvent.click(items[2]);
    expect(onselect).toHaveBeenCalledWith('delete');
  });

  it('schließt mit Esc, Tab, Klick daneben, Scrollen und Fensterwechsel', async () => {
    const { menu, onclose } = setup();
    await fireEvent.keyDown(menu, { key: 'Escape' });
    await fireEvent.keyDown(menu, { key: 'Tab' });
    await fireEvent.pointerDown(screen.getAllByRole('menuitem')[0]);
    expect(onclose).toHaveBeenCalledTimes(2);
    await fireEvent.pointerDown(document.body);
    await fireEvent.scroll(document);
    await fireEvent.blur(window);
    expect(onclose).toHaveBeenCalledTimes(5);
    const contextmenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    menu.dispatchEvent(contextmenu);
    expect(contextmenu.defaultPrevented).toBe(true);
  });

  it('zeigt Auswahlmenüs mit Häkchen an der aktiven Option', () => {
    const options: MenuEntry<string, SpriteIconName>[] = [
      { id: 'a', label: 'Alle', checked: true },
      { id: 'b', label: 'Archive', checked: false },
      { id: 'c', label: 'Ohne Icon' },
    ];
    render(ContextMenu<string>, { entries: options, x: 0, y: 0, onselect: vi.fn(), onclose: vi.fn() });
    const radios = screen.getAllByRole('menuitemradio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(radios[0].querySelector('svg')).not.toBeNull();
    expect(radios[1].querySelector('svg')).toBeNull();
    expect(screen.getByRole('menuitem').querySelector('svg')).toBeNull();
  });

  it('bleibt am Fensterrand im sichtbaren Bereich', () => {
    const { menu } = setup(window.innerWidth + 500, -50);
    expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth);
    expect(menu.style.top).toBe('4px');
  });
});

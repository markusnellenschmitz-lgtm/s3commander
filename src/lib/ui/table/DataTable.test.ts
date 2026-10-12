import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import DataTable from './DataTable.svelte';
import { Selection } from '../../core/table/selection.svelte';
import type { Column } from '../../core/table/types';
import { KeyListSource, mockClientHeight } from '../../../test/fakes';

const columns: Column<string>[] = [
  { id: 'name', label: 'Name', width: 'minmax(200px, 1fr)', sortable: true, text: (r) => `Zeile ${r}` },
  {
    id: 'size',
    label: 'Größe',
    width: '100px',
    align: 'end',
    meta: true,
    small: true,
    text: (r) => r.length.toString(),
  },
  { id: 'wide', label: 'Breit', width: '200px', mono: true, minWindowWidth: 99_999, text: () => 'x' },
];

let restoreHeight: () => void;
beforeEach(() => (restoreHeight = mockClientHeight(28 + 10 * 28)));
afterEach(() => restoreHeight());

function setup(props: Partial<Parameters<typeof render<typeof DataTable<string>>>[1]> = {}, size = 100) {
  const source = KeyListSource.ofSize(size);
  const selection = new Selection();
  const result = render(DataTable<string>, { source, columns, selection, label: 'Testtabelle', ...props });
  const grid = screen.getByRole('grid', { name: 'Testtabelle' });
  const rows = () => within(grid).getAllByRole('row').slice(1);
  return { source, selection, grid, rows, ...result };
}

describe('DataTable', () => {
  it('rendert nur sichtbare Zeilen plus Overscan', () => {
    const { rows, grid } = setup({}, 10_000);
    expect(rows()).toHaveLength(20);
    expect(grid).toHaveAttribute('aria-rowcount', '10001');
    expect(screen.getByText('Zeile k0')).toBeInTheDocument();
  });

  it('blendet Spalten unter ihrer Mindestfensterbreite aus', () => {
    setup();
    expect(screen.queryByRole('columnheader', { name: 'Breit' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Größe' })).toBeInTheDocument();
  });

  it('wählt per Klick, Strg+Klick und Checkbox', async () => {
    const { rows, selection } = setup();
    await fireEvent.click(rows()[2]);
    expect(rows()[2]).toHaveAttribute('aria-selected', 'true');
    await fireEvent.click(rows()[4], { ctrlKey: true });
    expect(selection.count(100)).toBe(2);
    await fireEvent.click(within(rows()[4]).getByRole('button', { name: 'Abwählen' }));
    expect(selection.count(100)).toBe(1);
  });

  it('Kopf-Checkbox wählt alles und hebt die Auswahl auf', async () => {
    const { selection } = setup();
    await fireEvent.click(screen.getByRole('button', { name: 'Alle auswählen' }));
    expect(selection.count(100)).toBe(100);
    await fireEvent.click(screen.getByRole('button', { name: 'Auswahl aufheben' }));
    expect(selection.count(100)).toBe(0);
  });

  it('bewegt den Cursor per Tastatur und scrollt ihn ins Bild', async () => {
    const { grid } = setup({}, 1000);
    await fireEvent.keyDown(grid, { key: 'End' });
    expect(grid.scrollTop).toBeGreaterThan(0);
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/-r999$/);
  });

  it('öffnet per Enter und Doppelklick', async () => {
    const onopen = vi.fn();
    const { grid, rows } = setup({ onopen });
    await fireEvent.dblClick(rows()[1]);
    expect(onopen).toHaveBeenLastCalledWith('k1', 1);
    await fireEvent.click(rows()[3]);
    await fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onopen).toHaveBeenLastCalledWith('k3', 3);
  });

  it('meldet Kontextmenüs per Rechtsklick und Umschalt+F10', async () => {
    const oncontextmenu = vi.fn();
    const { grid, rows } = setup({ oncontextmenu });
    await fireEvent.contextMenu(rows()[2], { clientX: 10, clientY: 20 });
    expect(oncontextmenu).toHaveBeenLastCalledWith({ x: 10, y: 20 }, 'k2', 2);
    await fireEvent.keyDown(grid, { key: 'F10', shiftKey: true });
    expect(oncontextmenu).toHaveBeenCalledTimes(2);
  });

  it('lässt das Browser-Kontextmenü ohne Handler zu', async () => {
    const { rows } = setup();
    const allowed = await fireEvent.contextMenu(rows()[2]);
    expect(allowed).toBe(true);
  });

  it('meldet Sortierwünsche und zeigt die Sortierrichtung', async () => {
    const onsort = vi.fn();
    const { rerender } = setup({ onsort, sort: { column: 'name', dir: 1 } });
    const header = screen.getByRole('columnheader', { name: /Name/ });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    await fireEvent.click(within(header).getByRole('button'));
    expect(onsort).toHaveBeenCalledWith({ column: 'name', dir: -1 });
    await rerender({ sort: { column: 'name', dir: -1 } });
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: 'Größe' })).not.toHaveAttribute('aria-sort');
  });

  it('zeichnet nach Umsortieren der Quelle neu', async () => {
    const { source, rerender } = setup({}, 30);
    source.reverse();
    await rerender({ source });
    expect(screen.getByText('Zeile k29')).toBeInTheDocument();
  });

  it('zeigt Skeleton-Zeilen für noch nicht geladene Einträge und fordert sie an', () => {
    const source = KeyListSource.ofSize(5);
    const ensureRange = vi.fn();
    const lazy = {
      ...source,
      length: 5,
      version: 0,
      get: () => undefined,
      keyAt: () => undefined,
      indexOfKey: () => -1,
      ensureRange,
    };
    render(DataTable<string>, { source: lazy, columns, selection: new Selection(), label: 'Laden' });
    const busy = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-busy') === 'true');
    expect(busy).toHaveLength(5);
    expect(ensureRange).toHaveBeenCalledWith(0, 5);
  });

  it('zeigt den Leerzustand nur ohne Zeilen', () => {
    const empty = createRawSnippet(() => ({ render: () => '<p>Dieser Bucket ist leer</p>' }));
    render(DataTable<string>, {
      source: KeyListSource.ofSize(0),
      columns,
      selection: new Selection(),
      label: 'Leer',
      empty,
    });
    expect(screen.getByText('Dieser Bucket ist leer')).toBeInTheDocument();
    render(DataTable<string>, {
      source: KeyListSource.ofSize(1),
      columns,
      selection: new Selection(),
      label: 'Voll',
      empty,
    });
    expect(screen.getAllByText('Dieser Bucket ist leer')).toHaveLength(1);
  });

  it('wendet zusätzliche Zeilenklassen und die kompakte Dichte an', () => {
    const { rows, grid } = setup({ compact: true, rowClass: () => 'is-error' });
    expect(grid).toHaveClass('is-compact');
    expect(rows()[0]).toHaveClass('is-error');
  });

  it('verstellt feste Spalten per Ziehen', async () => {
    const { grid } = setup();
    const handle = within(screen.getByRole('columnheader', { name: 'Größe' })).getByText('', {
      selector: '.s3-col-resize',
    });
    await fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    await fireEvent.pointerMove(handle, { clientX: 160, pointerId: 1 });
    await fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(grid.style.getPropertyValue('--cols')).toContain('60px');
  });

  it('übernimmt Scrollen des Containers', async () => {
    const { grid, rows } = setup({}, 1000);
    grid.scrollTop = 28 * 500;
    await fireEvent.scroll(grid);
    expect(rows()[0]).toHaveAttribute('aria-rowindex', String(490 + 2));
  });
  it('überlässt Alt-Kombinationen der Anwendung', async () => {
    const onopen = vi.fn();
    const { grid, rows } = setup({ onopen });
    await fireEvent.click(rows()[1]);
    await fireEvent.keyDown(grid, { key: 'Enter', altKey: true });
    expect(onopen).not.toHaveBeenCalled();
    await fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onopen).toHaveBeenCalledOnce();
  });

  it('zeichnet den Drop-Rahmen über dem sichtbaren Bereich und damit über dem Kopf', async () => {
    const { grid, rerender } = setup({ dropTarget: false }, 1_000);
    expect(grid.querySelector('.s3-drop-frame')).toBeNull();
    grid.scrollTop = 28 * 50;
    await fireEvent.scroll(grid);
    await rerender({ dropTarget: true });
    const frame = grid.querySelector<HTMLElement>('.s3-drop-frame')!;
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(frame.style.top).toBe(`${28 * 50}px`);
    expect(frame.style.height).toBe(`${28 + 10 * 28}px`);
  });
});

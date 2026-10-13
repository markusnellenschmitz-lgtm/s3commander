import { describe, expect, it } from 'vitest';
import { ObjectFilterViewModel } from './objectFilterViewModel.svelte';
import { ArraySource } from './arraySource.svelte';
import { Selection } from '../../core/table/selection.svelte';
import { filterSource } from './objectSource';
import { file, folder } from '../../../test/fakes';

const MiB = 1024 ** 2;

function setup() {
  const source = new ArraySource(
    [folder('daily'), file('a.tar', { size: 300 * MiB }), file('b.txt', { size: 10 }), file('c.txt', { size: 20 })],
    { column: 'name', dir: 1 },
  );
  const selection = new Selection();
  const target = { applyFilter: (query: Parameters<typeof filterSource>[2]) => filterSource(source, selection, query) };
  const vm = new ObjectFilterViewModel({ target, now: () => 0 });
  return { source, selection, vm };
}

describe('ObjectFilterViewModel', () => {
  it('filtert die Datenquelle und räumt die Auswahl auf', () => {
    const { source, selection, vm } = setup();
    selection.set('p/a.tar', true);
    selection.set('p/b.txt', true);
    vm.setText('txt');
    expect(vm.isActive).toBe(true);
    expect([source.length, source.totalCount, source.isFiltered]).toEqual([2, 4, true]);
    expect(selection.has('p/a.tar')).toBe(false);
    expect(selection.has('p/b.txt')).toBe(true);
    vm.clear();
    expect([source.length, source.isFiltered, vm.isActive]).toEqual([4, false, false]);
  });

  it('beschriftet Knöpfe und wählt Optionen über das Menü', () => {
    const { source, vm } = setup();
    expect([vm.buttonLabel('kind'), vm.buttonLabel('size'), vm.buttonLabel('date')]).toEqual(['Typ', 'Größe', 'Datum']);
    vm.openMenu('kind', 10, 20);
    expect(vm.menu).toMatchObject({ group: 'kind', x: 10, y: 20 });
    expect(vm.menu?.entries[0]).toEqual({ id: 'all', label: 'Alle Typen', checked: true });
    vm.choose('archive');
    expect(vm.menu).toBeNull();
    expect(vm.buttonLabel('kind')).toBe('Typ: Archive');
    expect(source.length).toBe(1);
    vm.openMenu('kind', 0, 0);
    expect(vm.menu?.entries.find((e) => e !== 'separator' && e.checked)).toMatchObject({ id: 'archive' });
    vm.closeMenu();
    vm.choose('folder');
    expect(vm.buttonLabel('kind')).toBe('Typ: Archive');
  });

  it('setzt Größe und Datum direkt und vergisst beim Ordnerwechsel nur den Suchtext', () => {
    const { source, vm } = setup();
    vm.setSize('small');
    expect(source.length).toBe(2);
    vm.setDate('older');
    expect(source.length).toBe(0);
    vm.setDate('all');
    vm.setKind('all');
    vm.setText('b');
    vm.onNavigate();
    expect(vm.filter).toEqual({ text: '', kind: 'all', size: 'small', date: 'all' });
    vm.onNavigate();
    expect(vm.buttonLabel('size')).toBe('Größe: Unter 1 MiB');
  });
});

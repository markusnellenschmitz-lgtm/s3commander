import { describe, expect, it } from 'vitest';
import { treeKeyAction, type TreeNode } from './tree';

const node = (id: string, overrides: Partial<TreeNode> = {}): TreeNode => ({
  id,
  level: 0,
  expandable: false,
  expanded: false,
  parentId: null,
  ...overrides,
});

const nodes: TreeNode[] = [
  node('c1', { expandable: true, expanded: true }),
  node('b1', { level: 1, parentId: 'c1' }),
  node('b2', { level: 1, parentId: 'c1' }),
  node('c2', { expandable: true, expanded: false }),
];

describe('treeKeyAction', () => {
  it.each([
    ['ArrowDown', 'b1', 'b2'],
    ['ArrowDown', 'c2', 'c2'],
    ['ArrowUp', 'b1', 'c1'],
    ['ArrowUp', 'c1', 'c1'],
    ['Home', 'b2', 'c1'],
    ['End', 'c1', 'c2'],
  ])('%s von %s bewegt zu %s', (key, from, to) => {
    expect(treeKeyAction(nodes, from, key)).toEqual({ type: 'move', id: to });
  });

  it('beginnt ohne Cursor oben', () => {
    expect(treeKeyAction(nodes, null, 'ArrowDown')).toEqual({ type: 'move', id: 'c1' });
    expect(treeKeyAction(nodes, null, 'ArrowUp')).toEqual({ type: 'move', id: 'c1' });
  });

  it('klappt mit Pfeil rechts auf oder geht zum ersten Kind', () => {
    expect(treeKeyAction(nodes, 'c2', 'ArrowRight')).toEqual({ type: 'expand', id: 'c2' });
    expect(treeKeyAction(nodes, 'c1', 'ArrowRight')).toEqual({ type: 'move', id: 'b1' });
    expect(treeKeyAction(nodes, 'b1', 'ArrowRight')).toEqual({ type: 'none' });
  });

  it('klappt mit Pfeil links zu oder geht zum Elternknoten', () => {
    expect(treeKeyAction(nodes, 'c1', 'ArrowLeft')).toEqual({ type: 'collapse', id: 'c1' });
    expect(treeKeyAction(nodes, 'b2', 'ArrowLeft')).toEqual({ type: 'move', id: 'c1' });
    expect(treeKeyAction(nodes, 'c2', 'ArrowLeft')).toEqual({ type: 'none' });
  });

  it('aktiviert mit Enter und Leertaste', () => {
    expect(treeKeyAction(nodes, 'b1', 'Enter')).toEqual({ type: 'activate', id: 'b1' });
    expect(treeKeyAction(nodes, 'b1', ' ')).toEqual({ type: 'activate', id: 'b1' });
    expect(treeKeyAction(nodes, null, 'Enter')).toEqual({ type: 'none' });
  });

  it('ignoriert unbekannte Tasten und leere Bäume', () => {
    expect(treeKeyAction(nodes, 'b1', 'x')).toEqual({ type: 'none' });
    expect(treeKeyAction([], null, 'ArrowDown')).toEqual({ type: 'none' });
  });
});

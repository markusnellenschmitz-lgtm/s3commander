import { describe, expect, it, vi } from 'vitest';
import { ClipboardViewModel } from './clipboardViewModel.svelte';
import { selectionOf, type ObjectSelection } from '../../core/backend';

const folder = { profileId: 'p', bucket: 'b', prefix: 'a/' };
const target = { profileId: 'p', bucket: 'b', prefix: 'z/' };
const item = (key: string) => ({ key, isFolder: false, size: 1, etag: null });
const selection: ObjectSelection = { folder, items: [item('a/x'), item('a/y')] };

function setup() {
  const paste = vi.fn().mockResolvedValue(undefined);
  const vm = new ClipboardViewModel({ paste });
  const context = { selection: selectionOf(selection), target };
  return { vm, paste, context };
}

describe('ClipboardViewModel', () => {
  it('merkt zum Kopieren und fügt beliebig oft ein', async () => {
    const { vm, paste, context } = setup();
    expect(vm.statusText).toBe('');
    expect(vm.handleShortcut('c', true, context)).toBe(true);
    await Promise.resolve();
    expect(vm.statusText).toBe('2 Einträge zum Kopieren gemerkt');
    expect(vm.handleShortcut('V', true, context)).toBe(true);
    expect(vm.handleShortcut('v', true, context)).toBe(true);
    expect(paste).toHaveBeenCalledTimes(2);
    expect(paste).toHaveBeenCalledWith(selection, target, false);
  });

  it('verschiebt einmal und leert danach die Ablage', async () => {
    const { vm, paste, context } = setup();
    vm.handleShortcut('x', true, { ...context, selection: selectionOf({ folder, items: [item('a/x')] }) });
    await Promise.resolve();
    expect(vm.statusText).toBe('1 Eintrag zum Verschieben gemerkt');
    vm.handleShortcut('v', true, context);
    expect(paste).toHaveBeenCalledWith({ folder, items: [item('a/x')] }, target, true);
    expect(vm.content).toBeNull();
    expect(vm.handleShortcut('v', true, context)).toBe(false);
  });

  it('ignoriert Kürzel ohne Strg, ohne Auswahl oder ohne Zielordner', async () => {
    const { vm, paste, context } = setup();
    expect(vm.handleShortcut('c', false, context)).toBe(false);
    expect(vm.handleShortcut('c', true, { ...context, selection: selectionOf(null) })).toBe(false);
    expect(vm.handleShortcut('q', true, context)).toBe(false);
    vm.handleShortcut('c', true, context);
    await Promise.resolve();
    expect(vm.handleShortcut('v', true, { ...context, target: null })).toBe(false);
    vm.clear();
    expect(vm.content).toBeNull();
    expect(paste).not.toHaveBeenCalled();
  });
});

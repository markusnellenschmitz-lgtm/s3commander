import { describe, expect, it, vi } from 'vitest';
import { focusTrap } from './focusTrap';

function dialog(html: string) {
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  const node = document.createElement('div');
  node.innerHTML = html;
  document.body.append(node);
  const onescape = vi.fn();
  const action = focusTrap(node, { onescape })!;
  return { node, outside, onescape, action };
}

const key = (node: HTMLElement, k: string, shiftKey = false) =>
  node.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

describe('focusTrap', () => {
  it('fokussiert data-autofocus, sonst das erste Element', () => {
    const { node } = dialog('<button id="a">A</button><input id="b" data-autofocus>');
    expect(document.activeElement).toBe(node.querySelector('#b'));
    const second = dialog('<button id="c">C</button>');
    expect(document.activeElement).toBe(second.node.querySelector('#c'));
  });

  it('hält Tab im Dialog in beide Richtungen', () => {
    const { node } = dialog('<button id="a">A</button><button id="b">B</button>');
    const [a, b] = node.querySelectorAll('button');
    b.focus();
    key(node, 'Tab');
    expect(document.activeElement).toBe(a);
    key(node, 'Tab', true);
    expect(document.activeElement).toBe(b);
    a.focus();
    key(node, 'Tab');
    expect(document.activeElement).toBe(a);
  });

  it('meldet Esc, ignoriert andere Tasten und Dialoge ohne Ziele', () => {
    const { node, onescape, action } = dialog('<button>A</button>');
    key(node, 'Escape');
    expect(onescape).toHaveBeenCalledOnce();
    key(node, 'x');
    const next = vi.fn();
    action.update?.({ onescape: next });
    key(node, 'Escape');
    expect(next).toHaveBeenCalledOnce();
    const empty = dialog('<span>leer</span>');
    expect(key(empty.node, 'Tab')).toBe(true);
  });

  it('gibt den Fokus beim Schließen zurück', () => {
    const { outside, action } = dialog('<button>A</button>');
    action.destroy?.();
    expect(document.activeElement).toBe(outside);
  });
});

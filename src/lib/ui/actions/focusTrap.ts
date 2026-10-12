// Svelte-Action für modale Dialoge: Fokus beim Öffnen hinein, Tab bleibt im Dialog,
// Esc meldet das Schließen (UI-SPEC §4 Dialog: "Fokusfalle, Esc schließt").
// Erstes Ziel: Element mit data-autofocus, sonst das erste fokussierbare Element.

import type { Action } from 'svelte/action';

export interface FocusTrapOptions {
  onescape: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

export const focusTrap: Action<HTMLElement, FocusTrapOptions> = (node, initial) => {
  let options = initial;
  const previous = document.activeElement as HTMLElement | null;
  (node.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(node)[0])?.focus();

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      options.onescape();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables(node);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  node.addEventListener('keydown', onKeyDown);
  return {
    update(next) {
      options = next;
    },
    destroy() {
      node.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    },
  };
};

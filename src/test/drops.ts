// Steuerbarer Drop-Port für Tests.

import type { FileDropEvent, FileDropPort } from '../lib/core/backend';

export interface ControlledDrops extends FileDropPort {
  emit(event: FileDropEvent): void;
  readonly subscribed: boolean;
}

export function controlledDrops(): ControlledDrops {
  let listener: ((event: FileDropEvent) => void) | null = null;
  return {
    async onFileDrop(l) {
      listener = l;
      return () => (listener = null);
    },
    emit: (event) => listener?.(event),
    get subscribed() {
      return listener !== null;
    },
  };
}

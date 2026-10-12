// Status-Punkt einer Verbindung (DESIGN-SYSTEM: Punkt in Baum, Tab und Statusleiste).

import type { ConnectionStatus } from './browserViewModel.svelte';

export const CONNECTION_DOT: Record<ConnectionStatus, { cls: string; label: string }> = {
  connected: { cls: 's3-dot-ok', label: 'Verbunden' },
  connecting: { cls: 's3-dot-busy', label: 'Verbindung wird aufgebaut' },
  error: { cls: 's3-dot-error', label: 'Fehler' },
  disconnected: { cls: 's3-dot-off', label: 'Getrennt' },
};

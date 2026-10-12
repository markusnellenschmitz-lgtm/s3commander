// Betriebssystem, auf dem die App läuft. Es unterscheidet sich nur in Texten und darin, ob es einen
// Teilen-Dialog des Systems gibt; das Backend wählt die passenden Adapter selbst.

export type Platform = 'windows' | 'linux';

/** Erkennt die Plattform am User-Agent der WebView: WebView2 nennt „Windows“, WebKitGTK „Linux“. */
export function detectPlatform(userAgent: string): Platform {
  return userAgent.includes('Windows') ? 'windows' : 'linux';
}

/** Wo Zugangsdaten liegen, für Sätze wie „Zugangsdaten werden im … abgelegt“. */
export function credentialStoreName(platform: Platform): string {
  return platform === 'windows' ? 'Windows-Anmeldeinformationsspeicher' : 'Schlüsselbund des Systems';
}

/** Nur Windows hat einen Teilen-Dialog des Systems (src-tauri/src/adapters/share_sheet.rs). */
export function hasShareSheet(platform: Platform): boolean {
  return platform === 'windows';
}

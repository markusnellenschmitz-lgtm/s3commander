# UI-SPEC – S3 Client

Stand: 11.10.2026. Grundlage: Briefing Abschnitte 6–8, Design-System „S3 Client“ (`design/`), Mockups (`reference/mockups/`).

---

## 1. Fensteraufbau

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Titelleiste 32                                                           │
├──────────────┬───────────────────────────────────────────────┬───────────┤
│ Seitenleiste │ Tab-Leiste 32                                 │ Details-  │
│ 240          │ Werkzeugleiste 40                             │ Panel 360 │
│ (180–400,    │ Pfad + Suche + Filter 44                      │ (optional,│
│ einklappbar) │ Objekt-Browser (flex)                         │ Alt+Enter)│
│              │ Transfer-Queue 32 eingeklappt / 280 offen     │           │
├──────────────┴───────────────────────────────────────────────┴───────────┤
│ Status-Leiste 24                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

| Bereich | Höhe/Breite | Fläche | Klassen |
|---|---|---|---|
| Titelleiste | 32 px | `bg-app` | eigene (`data-tauri-drag-region`) |
| Seitenleiste | 240 px, verstellbar 180–400 | `bg-app` | `s3-tree`, `s3-tree-group`, `s3-node` |
| Tab-Leiste | 32 px | `bg-app`, aktiver Tab `bg-panel` + 2 px `accent` unten | `s3-tabs`, `s3-tab` |
| Werkzeugleiste | 40 px | `bg-app` | `s3-btn-*`, Trenner 1×20 px |
| Pfadzeile | 44 px | `bg-app` | `s3-crumbs`, `s3-input`, `s3-btn-secondary` |
| Objekt-Browser | Rest | `bg-panel` | `s3-table` |
| Transfer-Queue | 32 / 280 px | `bg-app` Kopf, `bg-panel` Liste | `s3-xfer`, `s3-progress` |
| Details-Panel | 360 px | `bg-panel` | `s3-sidepanel`, `s3-props` |
| Status-Leiste | 24 px | `bg-app` | `s3-statusbar`, `s3-sb-item` |

Unter 1440 px Fensterbreite blendet die Tabelle die ETag-Spalte aus. Seitenleiste und Panels behalten ihre Breite, die Tabelle gibt nach.

---

## 2. Beispieldaten (für Storybook/Dev-Fixtures)

Verbindungen (Seitenleiste, in dieser Reihenfolge):

| Profil | Typ-Icon | Status | Buckets |
|---|---|---|---|
| AWS Produktion (eu-central-1) | `cloud` | verbunden | prod-backups-eu, prod-exports-eu (leer), prod-logs-eu (~1,28 Mio. Objekte), prod-media-eu, terraform-state-eu |
| Hetzner fsn1 | `cloud` | verbunden | gtg-mods, nextcloud-data, restic-repo |
| Cloudflare R2 Assets | `cloud` | verbindet | – |
| Backblaze B2 Archiv | `cloud` | Fehler | – |
| Garage Homelab | `server` | verbunden | – |
| MinIO lokal | `server` | getrennt | – |

Inhalt `prod-backups-eu/backups/2026/10/` (21 Einträge, Ordner zuerst):
`daily/ manifests/ wal/ weekly/`, `checksums-202610.sha256` (1,4 KiB), `db-full-20261001…20261011.tar.zst` (4,58–4,74 GiB, 01.–04.10. STANDARD_IA, Rest STANDARD, Multipart-ETags `"<32 hex>-147…157"`), `db-schema-20261011.sql` (412,8 KiB), `keys-20261001.tar.zst.gpg` (2,3 MiB, GLACIER_IR, Icon `file-lock`), `media-index-20261011.json.gz` (12,4 MiB), `README.txt`, `restore-test-20261008.log` (184,2 KiB).
Vollständige Liste mit Bytes und Zeitstempeln: Konstruktor in `reference/mockups/Prototyp.dc.html`.

---

## 3. Screens

### Screen 1 – Verbindungsdialog (`S1_Verbindung.dc.html`)
Modaler Dialog 980 px breit, Körper 600 px hoch, `s3-dialog`.
- **Kopf:** Titel „Neue Verbindung“ (`title`, 20/28), Hinweis „Zugangsdaten werden im Windows-Anmeldeinformationsspeicher abgelegt, nicht in der Profildatei.“, Schließen-Icon.
- **Links 248 px (`bg-panel`):** Gruppe „VORLAGE“, Liste AWS S3, MinIO, Backblaze B2, Cloudflare R2, Wasabi, Hetzner, Ceph, Garage, Trennlinie, Benutzerdefiniert. Je 32 px Zeile, Icon (`cloud` gehostet / `server` selbst gehostet / `sliders-horizontal` benutzerdefiniert), Name, rechts Zusatz in `fg-secondary`. Auswahl: `selection-bg` + 3-px-Akzentbalken links.
- **Rechts Formular (14 px):** Profilname · Endpoint-URL (mono, mit Hilfetext aus Vorlage) · Region (Select) | Bucket optional (Hilfetext „Leer lassen, um alle Buckets des Schlüssels zu listen.“) · Access Key (mono) | Secret Key (Passwort + Auge-Button).
- **Ausklappbereich „Erweitert“** (umrandeter Block, Kopf zeigt „2 Werte geändert“): Adressierung (Radio Virtual-Hosted / Path-Style) | Signaturversion (Select) · Eigene CA-Datei (Feld + „Durchsuchen …“) | Proxy · Timeout (s) | Parallelität | Checkbox „TLS-Zertifikat prüfen“.
- **Fuß:** links „Verbindung testen“ (sekundär) mit Inline-Ergebnis (`circle-check` + „Verbunden · 3 Buckets · 142 ms · TLS 1.3“ bzw. Fehler in `error-fg` mit S3-Code); rechts „Abbrechen“ (sekundär), „Speichern“ (primär).
- Vorlagen füllen Endpoint/Region/Adressierung vor. Hetzner: `https://{region}.your-objectstorage.com`, Regionen fsn1/nbg1/hel1.

### Screen 2 – Hauptfenster Standard (`Main.dc.html`, view=standard; Light: `S2_Light.dc.html`)
- Seitenleiste wie §2, gewählter Bucket `prod-backups-eu` (Auswahl inaktiv-grau, da Fokus in Tabelle). Unten „Neue Verbindung“ (sekundär, klein) + Einstellungen-Icon. Kopf: „VERBINDUNGEN“ + Einklappen-Icon (`panel-left-close`).
- Tabs: `prod-backups-eu` (aktiv), `prod-media-eu`, `gtg-mods`, je Status-Punkt + Schließen-x (sichtbar bei aktiv/hover), dahinter `+` (Strg+T).
- Werkzeugleiste: Zurück, Weiter (deaktiviert), Hoch · Aktualisieren · **Hochladen (einzige Primäraktion)**, Herunterladen, Neuer Ordner, Löschen (ghost) · rechts „Ansicht“: Liste / Zwei-Panel (gedrückt = aktiv) · Details-Panel-Toggle.
- Pfadzeile: Breadcrumb `[Bucket-Icon] prod-backups-eu › backups › 2026 › 10` + „Pfad kopieren“, Suchfeld 280 px („Filtern in backups/2026/10/“, Kürzel Strg+F), Filter-Buttons Typ ▾ / Größe ▾ / Datum ▾.
- Tabelle: Spalten Checkbox 28 · Name (min 260, flex) · Größe 104 (rechts) · Geändert 140 · Storage Class 120 · ETag 300 (mono 12, ausblendbar). Sortiert nach Name ↑, Ordner zuerst. **3 Zeilen ausgewählt** (09., 10., 11.10.), Cursor auf 11.10. Kopf-Checkbox „gemischt“.
- Transfer-Queue eingeklappt (32 px): Button „Transfers Strg+J“, Badges „2 aktiv“ (info), „5 wartend“, „1 Fehler“ (error), aktueller Vorgang „db-full-20261011.tar.zst · Teil 101 von 152“, „18,4 von 29,7 GiB“, Balken 62 %, „48,2 MiB/s“, „noch 4 Min.“.
- Status-Leiste: `● AWS Produktion · eu-central-1` | `17 Objekte · 4 Ordner` | **`3 ausgewählt · 14,16 GiB`** | … | rechts Transfer-Kurzinfo mit Mini-Balken (klickbar = Strg+J) | `SigV4 · Virtual-Hosted · TLS 1.3`.

### Screen 3 – Zwei-Panel (`view=split`)
Ersetzt Pfadzeile + Tabelle durch: links „LOKAL“ (Pfad `D: › Backups › db-prod`, Spalten Name/Größe/Geändert, fokussiert, 2 Dateien ausgewählt), Mitte 44 px Leiste mit „→ in den Bucket kopieren“ und „← lokal speichern“ (deaktiviert ohne Auswahl rechts), rechts Bucket (`prod-backups-eu › backups › 2026 › 10`, Spalten + Storage Class).
Drag-and-drop: Drop-Ziel-Zeile `daily/` mit `selection-bg` und 2 px gestricheltem `accent`-Rahmen innen, Badge „Ablegen: 2 Dateien kopieren“; Drag-Vorschau (schwebend, `bg-raised`, `shadow-menu`): „2 Dateien · 610,7 MiB / Kopieren nach backups/2026/10/daily/“.
Ansicht-Toggle in der Werkzeugleiste steht auf Zwei-Panel.

### Screen 4 – Transfer-Queue offen (`view=queue`)
Höhe 280 px. Kopf 36 px: Einklappen „Transfers Strg+J“ · Tabs (plain) **Alle 22** · Aktiv 2 · Wartend 5 · Fertig 14 · Fehler 1 · rechts Gesamt „18,4 von 29,7 GiB“, Balken 180 px, „62 %“, „↑ 31,6 MiB/s ↓ 16,6 MiB/s“, „noch 4 Min.“, Buttons „Alle pausieren“, „Fortsetzen“ (deaktiviert, solange nichts pausiert), „Fertige entfernen“.
Spaltenkopf: Richtung · Objekt · Größe · Fortschritt · Status · Tempo · Rest · Aktionen.
Zeilen (alle Zustände): aktiv Upload (Teil 101/152, ausgewählt), aktiv Download, **fehlgeschlagen** (Zeile `error-bg`, darunter Fehlerzeile 32 px: „**RequestTimeout** · Der Endpunkt hat 30 s lang keine Daten angenommen. Ein neuer Versuch setzt bei Teil 4 von 4 fort. HTTP 400 · Request-ID …“ + Kopieren + **„Erneut versuchen“**), pausiert, wartend („Wartend · Platz 1“), fertig („Fertig · 15:09“, Ø-Tempo), abgebrochen (durchgestrichen).
Zeilen-Aktionen erscheinen bei Hover/Auswahl/Fokus; „Erneut versuchen“/Entfernen bei Fehlern immer sichtbar (`is-pinned`).

### Screen 5 – Objekt-Details (`view=details`)
Rechts 360 px, `s3-sidepanel`. Kopf 40 px: Dateityp-Icon, Name, Schließen. Tabelle zeigt ohne ETag-Spalte, eine Auswahl.
Abschnitte als zusammenklappbare Gruppen (Kopf 28 px, `bg-subtle`, Chevron-Button mit `aria-expanded`):
1. **Allgemein** (`s3-props`): Key (mono, Kopieren bei Hover) · Größe „4,74 GiB (5.089.471.232 Bytes)“ · Content-Type · ETag (mono) · Storage Class · Letzte Änderung (mit Sekunden).
2. **Metadaten** (bearbeitbar, „+ Hinzufügen“): Cache-Control, x-amz-meta-pg-version, x-amz-meta-source-host, x-amz-meta-retention (in Bearbeitung, `is-editing is-dirty`). Darunter Leiste „1 Änderung · Speichern kopiert das Objekt auf sich selbst“ + Verwerfen / Speichern (sekundär).
3. **Tags** (bearbeitbar, „4 von 10“): Chips key|value mit x, gestrichelter „+ Tag“.
4. **Versionen**: Zeilen Version-ID (mono) + Badge „aktuell“ / „Delete Marker“ (warning) · Datum · Größe · Wiederherstellen-Icon bei Hover; darunter Button „p7Kd2sVb… wiederherstellen“.
5. **Freigabe**: Gültigkeit (Select „24 Stunden“) + „bis 12.10.2026 15:23“, Presigned URL (mono, readonly) + „Kopieren“.
6. **Berechtigungen** (eingeklappt): Zusammenfassung „ACLs deaktiviert · Public Access blockiert“.

### Screen 6 – Zustände
- **6a leer** (`prod-exports-eu`): Spaltenkopf bleibt, darunter `s3-state` mittig: Icon `folder-open`, „Dieser Bucket ist leer“, „prod-exports-eu enthält noch keine Objekte. Dateien hierher ziehen oder hochladen.“, „Dateien hochladen Strg+U“ (sekundär – Primär bleibt in der Toolbar), „Neuer Ordner“ (ghost). Herunterladen/Löschen deaktiviert.
- **6b Listing läuft** (`prod-logs-eu/cloudfront/`): 2 px unbestimmter Balken über dem Tabellenkopf, Tabelle füllt sich, am Ende 3 Skeleton-Zeilen (statisch, kein Shimmer). Status-Leiste: Loader-Icon in `info-fg` + „**1.284.000 Objekte geladen, Listing läuft** · 21.400 Objekte/s“ + Button „Listing abbrechen“.
- **6c Verbindungsfehler**: `s3-banner-error` über der Tabelle (kein Modal): Titel „SignatureDoesNotMatch: Prüfe Secret Key und Region“, Ursachentext, mono-Zeile „SignatureDoesNotMatch · HTTP 403 · Request-ID … · Zeitstempel“, Request-ID kopieren, „Erneut verbinden“, „Profil bearbeiten“. Tabelle leer mit Hinweis auf letztes erfolgreiches Listing. Status-Punkt der Verbindung in Baum, Tab und Status-Leiste auf Fehler (Raute). Hochladen/Neuer Ordner deaktiviert.

### Screen 7 – Einstellungen (`S7_Einstellungen.dc.html`)
Dialog 980 × (Kopf + 560 + Fuß). Kopf: Titel + Einstellungs-Suche 240 px + Schließen.
Links 220 px Kategorien: Allgemein · **Transfers** (gewählt, Badge „2“ = ungespeicherte Änderungen) · Cache · Darstellung · Sicherheit · Über.
Inhalt Transfers als Formularzeilen (Label-Spalte 220 px mit Erklärung):
Parallelität (Transfers 8, Teile pro Datei 4) · Chunk-Größe (Select 16 MiB, „Multipart ab 64 MiB“, Hinweis 10.000-Teile-Grenze = 156 GiB) · Bandbreitenlimit (Toggle + Upload 50 MiB/s, Download unbegrenzt) · Konflikte (Radio: Jedes Mal fragen, Überspringen, Überschreiben wenn neuer, Immer überschreiben, Umbenennen mit Beispiel) · Prüfung (CRC32C nach Upload, Wiederholen 3×).
Fuß: „Standardwerte“ (ghost) links, „2 Änderungen in Transfers“, Abbrechen, Speichern (primär).
Übrige Kategorien (nicht gezeichnet, Inhalt laut Briefing): Cache (Größe, Ort, Leeren), Darstellung (Theme System/Dark/Light, Dichte 28/24, sichtbare Spalten), Sicherheit (Credential-Speicher, eigene Zertifikate), Über.

---

## 4. Komponenten → CSS → Svelte

| Svelte-Komponente | Klassen | Wichtige Props |
|---|---|---|
| `Button.svelte` | `s3-btn` + `-primary/-secondary/-ghost/-danger`, `-sm`, `-icon` | `variant`, `size`, `icon`, `kbd`, `disabled`, `pressed` |
| `IconButton.svelte` | `s3-btn s3-btn-ghost s3-btn-icon` | `icon`, `label` (Pflicht → `aria-label` + Tooltip mit Kürzel) |
| `TextField.svelte` | `s3-field`, `s3-input`, `s3-field-label/-help/-error` | `label`, `help`, `error`, `mono`, `size` |
| `Select.svelte` / `Combobox.svelte` | `s3-input s3-select`, `s3-menu`, `s3-menu-item` | `options`, `value` |
| `Checkbox`, `Radio`, `Toggle` | `s3-check(-box)`, `s3-radio(-dot)`, `s3-toggle(-track)` | `checked`, `indeterminate`, `disabled` |
| `Tabs.svelte` | `s3-tabs`, `s3-tab`, `s3-tabs-plain` | `tabs[{id,label,status,closable}]`, `active` |
| `Breadcrumb.svelte` | `s3-crumbs`, `s3-crumb`, `s3-crumb-sep` | `bucket`, `segments`, Strg+L → Eingabemodus |
| `ConnectionTree.svelte` | `s3-tree`, `s3-node`, `s3-dot-*` | `connections`, `selectedId` |
| **`DataTable.svelte`** | `s3-table`, `s3-thead`, `s3-th`, `s3-tbody.is-virtual`, `s3-tr`, `s3-td` | `columns`, `rows` (Accessor), `rowCount`, `selection`, `sort`, `compact`, `loading` |
| **`TransferRow.svelte`** / `TransferPanel.svelte` | `s3-xfer`, `s3-xfer-*`, `s3-progress-*` | `transfer`, `selected` |
| `PropertyGrid.svelte` | `s3-props`, `s3-prop-row`, `s3-prop-k/-v` | `rows[{key,value,mono,editable}]` |
| `SidePanel.svelte` | `s3-sidepanel`, `s3-sidepanel-head/-body` | `title`, `icon` |
| `Dialog.svelte` | `s3-scrim`, `s3-dialog`, `s3-dialog-body/-foot/-title` | `title`, `open`; Fokusfalle, Esc schließt |
| `Banner.svelte` | `s3-banner-error/-warning/-info` | `kind`, `title`, `detail`, `code`, `requestId`, Actions-Slot |
| `EmptyState.svelte` | `s3-state`, `s3-state-icon/-title/-actions` | `icon`, `title`, `text`, Actions-Slot |
| `Toast.svelte` | `s3-toast-*` | `kind`, `title`, `text`, `actions` |
| `StatusBar.svelte` | `s3-statusbar`, `s3-sb-item` (`is-right`, `is-button`, `is-error`) | Segmente als Slots |
| `Badge`, `Chip`, `StatusDot`, `ProgressBar`, `Kbd`, `Tooltip`, `Menu` | siehe `components.css` | – |

Zustände: native Pseudoklassen wo möglich, `is-*` für Auswahl, Cursor, Fehler, Laden, inaktives Fenster.

### DataTable – Pflichten
- Feste Zeilenhöhe (`--rh` = 28 bzw. 24 mit `.is-compact`). Virtuell: `.s3-tbody.is-virtual` mit Höhe `rowCount * rh`; jede sichtbare Zeile `position:absolute`, `style="--i: <index>"` (CSS übersetzt per `translateY`). Overscan ~10 Zeilen.
- Spalten per CSS-Grid über `--cols`; Breiten verstellbar (`.s3-col-resize`), ETag aus-/einblendbar, Auswahl der Spalten in Einstellungen › Darstellung.
- Kopf sticky (`z-sticky`), sortierte Spalte `is-sorted` + Chevron, `aria-sort`.
- Ordner (Präfixe) immer zuerst, unabhängig von Sortierung.
- Auswahl-Hintergrund `selection-bg` nur wenn Tabelle fokussiert, sonst `selection-bg-inactive` (CSS erledigt das über `:focus-within`).
- Listing streamt seitenweise (ListObjectsV2, 1.000 pro Seite) ins Modell; die Tabelle zeigt bereits geladene Zeilen plus Skeleton-Zeilen am Ende; Status-Leiste zählt mit.
- Fehlerzeilen (`is-error`) für Objekte, auf die z. B. HeadObject fehlschlägt.

---

## 5. Verhalten (Referenz: `Prototyp.dc.html`)

### Auswahl
- Klick: nur diese Zeile, Anker = Zeile.
- Strg+Klick: Zeile umschalten, Anker = Zeile.
- Umschalt+Klick: Bereich Anker…Zeile (mit Strg zur bestehenden Auswahl addieren).
- Checkbox-Klick: wie Strg+Klick, ohne Zeilen-Klick auszulösen.
- Kopf-Checkbox: keine → alle, gemischt/alle → keine.
- Auswahl ist schlüsselbasiert (Key), überlebt Umsortieren.

### Sortierung
Klick auf Spaltenkopf: gleiche Spalte → Richtung umkehren, neue Spalte → aufsteigend. Namen mit `localeCompare('de', {numeric:true, sensitivity:'base'})`.

### Transfer-State-Machine
```
waiting ──(Slot frei, Queue nicht pausiert)──► active ──(fertig)──► done
   ▲                                             │ │
   │ retry / resume                      pause   │ │ Fehler
   │                                             ▼ ▼
 failed ◄──────────────────────────────────── paused / failed
 active|waiting|paused ──cancel──► cancelled
```
- Max. parallel = Einstellung „Gleichzeitige Transfers“ (Default 8; Prototyp nutzt 2 zur Demo).
- „Alle pausieren“: active+waiting → paused, Queue-Flag pausiert. „Fortsetzen“: paused → waiting, Flag aus.
- „Erneut versuchen“ setzt bei letztem bestätigten Multipart-Teil fort (`UploadId` merken, `ListParts`).
- Fortschritt in 32-MiB-Teilen anzeigen: „Teil x / y“. Tempo gleitend gemittelt, Restzeit = offene Bytes / Tempo, < 60 s in Sekunden, sonst Minuten.
- Gesamtfortschritt über alle nicht abgebrochenen Transfers.
- Fertig/Fehler → Toast (relativ „vor 2 Min.“, absoluter Zeitstempel im Tooltip); Fehler zusätzlich als Fehlerzeile in der Queue und `is-error` in der Status-Leiste.

### Formatierung
```ts
formatBytes(b): Binärschritte B/KiB/MiB/GiB/TiB; GiB+ unter 10 mit 2 Nachkommastellen, sonst 1; Dezimalkomma.
formatCount(n): Tausenderpunkt (12.483.920).
formatDate(d): "11.10.2026 03:14" (Liste), mit Sekunden im Eigenschaften-Raster.
```
`Intl.NumberFormat('de-DE')` / `Intl.DateTimeFormat('de-DE')` verwenden.

---

## 6. Tastatur

| Kürzel | Aktion |
|---|---|
| Strg+L | Pfad bearbeiten |
| F5 | Aktualisieren |
| Rücktaste / Alt+↑ | Eine Ebene hoch |
| Alt+← / Alt+→ | Zurück / Weiter |
| Enter | Öffnen |
| F2 | Umbenennen |
| Entf | Löschen (Bestätigungsdialog nennt Ziel und Menge: „4.210 Objekte (38,6 GiB) und 112 ältere Versionen werden endgültig gelöscht.“) |
| Strg+C / X / V | Kopieren / Ausschneiden / Einfügen |
| Strg+U / Strg+D | Hochladen / Herunterladen |
| Strg+A | Alles auswählen |
| Strg+F | Filtern |
| Alt+Enter | Eigenschaften-Panel |
| Strg+J | Transfer-Panel |
| Strg+T / Strg+W | Tab neu / schließen |
| Umschalt+F10 | Kontextmenü |
| In Listen | ↑ ↓ Bild↑ Bild↓ Pos1 Ende bewegen Cursor; Umschalt erweitert; Strg bewegt nur Cursor; Leertaste schaltet um; Esc hebt auf |

Kürzel immer in deutscher Beschriftung, in Menü und Tooltip in `.s3-kbd`.

---

## 7. Datenmodell (TypeScript, Frontend)

```ts
type ConnStatus = 'connected' | 'connecting' | 'error' | 'disconnected';
type Provider = 'aws' | 'minio' | 'b2' | 'r2' | 'wasabi' | 'hetzner' | 'ceph' | 'garage' | 'custom';

interface ConnectionProfile {
  id: string;
  name: string;              // "Hetzner Produktion"
  provider: Provider;
  endpoint: string;          // "https://fsn1.your-objectstorage.com"
  region: string;
  defaultBucket?: string;
  addressing: 'virtual-hosted' | 'path-style';
  signatureVersion: 'v4' | 'v2';
  caFile?: string;
  proxy?: string;
  timeoutSec: number;        // 60
  concurrency: number;       // 8
  verifyTls: boolean;
  // Access/Secret Key NICHT hier – nur Referenz auf Windows Credential Manager
  credentialRef: string;
}

interface ConnectionState { profileId: string; status: ConnStatus; error?: S3Error; buckets?: string[]; }

interface S3Entry {
  key: string;               // voller Key
  name: string;              // letztes Segment, Ordner mit "/"
  isPrefix: boolean;
  size?: number;             // Bytes
  lastModified?: string;     // ISO
  storageClass?: string;     // STANDARD, STANDARD_IA, GLACIER_IR, …
  etag?: string;
}

interface S3Error { code: string; httpStatus: number; message: string; requestId?: string; at: string; }

type TransferState = 'waiting' | 'active' | 'paused' | 'done' | 'failed' | 'cancelled';
interface Transfer {
  id: string;
  direction: 'upload' | 'download' | 'copy';
  source: string;            // lokaler Pfad oder s3://bucket/key
  target: string;
  totalBytes: number;
  doneBytes: number;
  state: TransferState;
  bytesPerSec: number;       // gleitend
  partSize: number;          // 16 MiB Default
  uploadId?: string;         // für Fortsetzen
  error?: S3Error;
  finishedAt?: string;
}
```
Zustand in Svelte-Stores: `connections`, `tabs`, `activeTab` (bucket + prefix + selection + sort), `transfers`, `settings`, `theme`. Transfer-Engine und S3-Aufrufe im Rust-Backend (Tauri-Commands + Events für Fortschritt), nicht im WebView.

---

## 8. Umsetzungsreihenfolge

1. Styles einbinden, Theme-Umschaltung, Icon-Komponente.
2. Basis: Button, IconButton, TextField, Select, Checkbox/Radio/Toggle, Badge, StatusDot, ProgressBar, Kbd, Tooltip.
3. **DataTable** (virtuell, Auswahl, Sortierung, Tastatur) – mit 1 Mio. Fixture-Zeilen testen.
4. **TransferRow + TransferPanel** inkl. State-Machine (zunächst gegen Mock-Engine wie im Prototyp).
5. Fensterlayout: Titelleiste, Seitenleiste/Baum, Tabs, Toolbar, Breadcrumb, Status-Leiste.
6. Banner, EmptyState, Skeleton-Zeilen, Toast.
7. SidePanel + PropertyGrid (Screen 5).
8. Zwei-Panel-Ansicht + Drag-and-drop (Screen 3).
9. Dialoge: Verbindung (Screen 1), Einstellungen (Screen 7).

---

## 9. Offene Punkte / bewusste Abweichungen

1. **Titelleiste:** Das Mockup zeigt eine eigene Titelleiste (Tauri `decorations: false`). Nachteil unter Windows 11: das Snap-Layout-Flyout am Maximieren-Button fehlt ohne Zusatzaufwand. Alternative: native Titelleiste mit Dark-Mode-Rahmen. Entscheidung vor Schritt 5 treffen.
2. **Tab „Alle“** in der Transfer-Queue ist zusätzlich zum Briefing (Aktiv/Wartend/Fertig/Fehler), damit alle Zustände in einer Liste sichtbar sind.
3. **Einheiten:** Binär (GiB) gemäß Design-System, nicht „GB“ wie im Briefing-Beispiel.
4. **Lücken im Design-System:** kein Hover-Zustand für Eingabefelder (Mockup: Rahmen `fg-secondary`), kein Gedrückt-Zustand für den Destruktiv-Button (Mockup: wie Hover). Bitte im CSS ergänzen und hier festhalten.
5. **Tab-Schließen:** Im Mockup ist das x ein `span` im Tab-Button (verschachtelte Buttons sind ungültig). Umsetzung: Tab als `div[role=tab]` mit Roving Tabindex, x als eigener `button tabindex=-1`; Schließen per Tastatur über Strg+W / Entf auf dem Tab.
6. **Parallelität:** Prototyp demonstriert mit 2 aktiven Transfers, App-Default ist 8.
7. Schriften Segoe UI Variable / Cascadia Code sind Systemschriften – nicht bündeln.

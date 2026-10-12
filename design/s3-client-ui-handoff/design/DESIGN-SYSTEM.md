Ein Arbeitswerkzeug für S3-kompatiblen Object Storage auf Windows 11 — Amazon S3, MinIO, Backblaze B2, Cloudflare R2, Wasabi, Hetzner Object Storage, Ceph, Garage. Es soll sich anfühlen wie ein professioneller Dateimanager: dicht, ruhig, mit der Tastatur bedienbar und mit Zustand, der immer sichtbar ist. Technik: Tauri 2 + WebView2, Svelte mit reinem CSS. Alles hier ist CSS-Variablen, Flexbox, Grid und einfache HTML-Strukturen.

## Prinzipien

1. **Dichte vor Weißraum.** Jede Pixelzeile zeigt Daten. Abstände nur aus dem 4-px-Raster (`space-2` … `space-32`); in Listen nie mehr als `space-8` Innenabstand.
2. **Dateimanager, nicht Dashboard.** Vorbilder: Explorer-Detailansicht, WinSCP, Total Commander, Cyberduck, VS-Code-Seitenleisten. Keine Karten, keine Kacheln mit Kennzahlen, keine Hero-Flächen, keine schwebenden Aktionsknöpfe.
3. **Zustand immer sichtbar, ohne Modal.** Verbindungsstatus (Punkt in Baum, Tab und Status-Leiste), laufende Transfers (Transfer-Panel + Status-Leiste), Listing-Fortschritt (Status-Leiste) und Fehler (Fehlerzeile, Fehlerleiste, Toast) sind permanent da. Dialoge nur für Entscheidungen, nie für Fortschritt.
4. **Farbe trägt Bedeutung.** Eine Akzentfarbe (`accent`) für Auswahl, Fokus-nahe Zustände und die Primäraktion. Vier semantische Paare (`success-*`, `warning-*`, `error-*`, `info-*`). Alles andere ist neutrales Grau. Kein Element wird nur zur Dekoration eingefärbt.
5. **Tastatur gleichwertig.** Jedes interaktive Element hat einen sichtbaren Fokus (`focus-ring`), jede häufige Aktion ein Kürzel, das in Menü und Tooltip steht.
6. **Fluent-nah, aber eigenständig.** Radien 4 px (`radius-md`), dezente Trennlinien (`border-subtle`), drei ruhige Flächenebenen. Keine Acryl-/Glas-Effekte, keine Verläufe, keine Microsoft-Produktoptik.

## Farbe

Dark ist das erste Theme und Standard; Light ist gleichwertig und vollständig definiert. Umschalten über `data-theme="dark|light"` am `<html>`; ohne Attribut gilt Dark. Beim Start folgt die App der Windows-Einstellung (`prefers-color-scheme`), überschreibbar in den Einstellungen.

- **Flächen in drei Ebenen:** `bg-app` (Fensterrahmen, Seitenleiste, Toolbar, Status-Leiste) → `bg-panel` (Arbeitsfläche: Tabelle, Transfers, Eigenschaften) → `bg-raised` (Menüs, Dialoge, Tooltips, Felder). Zwischentöne: `bg-subtle` (Spaltenköpfe, Sekundär-Button), `bg-hover`, `bg-pressed`.
- **Text:** `fg-primary` für Inhalte, `fg-secondary` für Metadaten, Spaltenköpfe, Größen und Zeiten, `fg-disabled` nur für Inaktives. Beide lesbaren Stufen halten ≥ 4,5:1 auf jeder Fläche einschließlich `selection-bg` — in beiden Themes geprüft.
- **Rahmen:** `border-subtle` trennt Bereiche (dekorativ), `border-strong` umrandet Controls (≥ 3:1).
- **Auswahl:** `selection-bg` bei fokussierter Liste, `selection-bg-inactive` sobald Liste oder Fenster den Fokus verlieren — wie im Explorer. Text auf Auswahl bleibt `fg-primary`.
- **Akzent:** `accent` / `accent-hover` / `accent-pressed`, Text darauf `on-accent` (nie fest weiß — im Dark-Theme ist die Akzentfläche hell). Pro Ansicht höchstens ein Primär-Button.
- **Semantik:** `*-fg` für Text und Icons, `*-bg` als Fläche dahinter. Fehler: abgelehnte Requests, fehlgeschlagene Transfers, ungültige Felder. Warnung: pausiert, verbindet, Teilergebnis, Kosten (Glacier-Abruf, Requester Pays). Erfolg: verbunden, fertig. Info: laufende Hintergrundarbeit, Hinweise. Der Destruktiv-Button füllt mit `error-fg`, Text `on-error`.
- **Farbe nie allein:** Erfolg und Fehler unterscheiden sich in beiden Themes kaum in der Helligkeit. Darum trägt jeder Zustand zusätzlich ein Icon oder Wort, und die Status-Punkte unterscheiden sich in der Form (Kreis, Ring, Raute, dünner Ring).

## Typografie

Systemschrift, keine Webfonts: `sans` = Segoe UI Variable Text (Fallback Segoe UI), `display` = Segoe UI Variable Display nur für `title`, `mono` = Cascadia Code (Fallback Consolas). Auf Nicht-Windows-Rechnern zeigen die Vorschauen hier die Ersatzschrift — maßgeblich ist die Darstellung unter Windows 11.

| Stil | Größe / Zeile | Wofür |
|---|---|---|
| `caption` | 11 / 16 | Badges, Chips, Kürzel im Menü |
| `small` | 12 / 16 | Status-Leiste, Spaltenköpfe, Tooltips, Hilfetexte |
| `body` | 13 / 20 | **Standard** für Tabellen, Listen, Baum, Menüs, Buttons |
| `dialog` | 14 / 20 | Text und Controls in Dialogen |
| `subtitle` | 16 / 22 | Leer- und Fehlerzustände, Panel-Titel |
| `title` | 20 / 28 | Dialogtitel — die einzige Stelle mit 20 px |
| `mono`, `mono-small` | 13 / 20, 12 / 16 | Schlüssel in Eigenschaften, ETags, Version-IDs, ARNs, Endpunkte, JSON |

Gewichte nur `weight-regular` (400) und `weight-semibold` (600). Zahlen in Spalten immer `font-variant-numeric: tabular-nums` (`.s3-num`), rechtsbündig. Versalien nur für Gruppenköpfe der Seitenleiste (`small-strong`, +0.04em) und S3-Konstanten (STANDARD, GLACIER).

## Abstand, Größe, Radius, Ebenen

- **Zeilenhöhe** `row-height` 28 px, kompakt `row-height-compact` 24 px — gilt für Tabelle, Baum, Transfer-Liste, Eigenschaften und Menüeinträge. Feste Höhe ist Voraussetzung für das virtuelle Scrolling.
- **Controls** `control-sm` 24 px (Zeilen, Panel-Köpfe, Filter) und `control-md` 32 px (Toolbar, Dialoge). Toolbar 40 px, Status-Leiste `statusbar-height` 24 px.
- **Icons** `icon-md` 16 px, in kompakter Dichte `icon-sm` 14 px.
- **Radien** `radius-sm` 2 px (Badges, Chips, Checkbox, Balken), `radius-md` 4 px (Standard), `radius-lg` 6 px (Dialog). Tabellen und Panels sind eckig.
- **Schatten** nur `shadow-menu` (Menüs, Tooltips, Toasts) und `shadow-dialog`. Zeilen, Tabellen und angedockte Panels haben keinen Schatten.
- **Ebenen** `z-base` < `z-sticky` (Spaltenköpfe) < `z-popover` < `z-dialog` < `z-toast`.

## Bewegung

`duration-fast` 100 ms für Hover/Pressed, `duration-base` 150 ms für Menüs, Tooltips, Chevrons und Toggle, `duration-slow` 200 ms für Dialog, Panel, Toast — nie länger. Kurve `ease-standard`. Keine Shimmer-Effekte auf Skeleton-Zeilen, kein Einblenden von Tabellenzeilen. Bei `prefers-reduced-motion` fallen alle Übergänge auf 0 ms und der unbestimmte Balken steht still.

## Fokus und Tastatur

- Fokusring: 2 px solide `focus-ring`, 1 px Abstand (`outline-offset: 1px`); in Eingabefeldern innen, in Listen als 1-px-Rahmen der Cursorzeile. Nur bei `:focus-visible`, nie entfernt. Der Ring hält ≥ 3:1 auf allen Flächen inkl. `selection-bg`.
- Listen (Tabelle, Baum, Transfers) sind je **ein** Tab-Stopp mit eigenem Cursor (`aria-activedescendant` oder Roving Tabindex); die Pfeiltasten bewegen darin.
- Feste Kürzel: Strg+L Pfad bearbeiten · F5 Aktualisieren · Rücktaste / Alt+↑ eine Ebene hoch · Enter Öffnen · F2 Umbenennen · Entf Löschen · Strg+C/X/V Kopieren/Ausschneiden/Einfügen · Strg+U Hochladen · Strg+D Herunterladen · Strg+A Alles auswählen · Strg+F Filtern · Alt+Enter Eigenschaften · Strg+J Transfer-Panel · Strg+T neuer Tab · Strg+W Tab schließen · Umschalt+F10 Kontextmenü.
- Kürzel werden mit deutscher Tastenbeschriftung geschrieben („Strg“, „Umschalt“, „Entf“) und in `.s3-kbd` gesetzt.

## Sprache und Inhalte

- Deutsch, Sie-Form nur wo unvermeidlich; bevorzugt neutral-imperativ: „Dateien hierher ziehen oder hochladen.“ Kurze Sätze, kein Ausrufezeichen, keine Emoji, kein Marketington.
- S3-Begriffe bleiben im Original, wo Admins sie suchen: Bucket, Präfix, Objekt, ETag, Presigned URL, Multipart, Storage Class (Werte in Versalien). Ordner heißen in der UI „Ordner“, im Eigenschaften-Raster „Präfix“.
- Zahlen deutsch formatiert: 12.483.920 Objekte, 2,31 GiB. Größen in Binäreinheiten (KiB, MiB, GiB, TiB), exakte Bytes im Eigenschaften-Raster und Tooltip. Zeiten in Listen absolut („11.10.2026 03:14“), relativ nur in Toasts, mit absolutem Zeitstempel im Tooltip.
- Fehlermeldungen nennen, was nicht ging, warum, und was man tun kann — dazu der S3-Code und die Request-ID zum Kopieren: „Dem Zugangsschlüssel fehlt die Berechtigung s3:ListBucket für assets-cdn.“ + „AccessDenied · HTTP 403 · Request-ID …“.
- Destruktive Aktionen nennen Ziel und Menge: „4.210 Objekte (38,6 GiB) und 112 ältere Versionen werden endgültig gelöscht.“

## Ikonografie

Lucide Icons (ISC-Lizenz), als Inline-SVG mit `stroke="currentColor"`, `stroke-width` 1.75, 16 px (`.s3-ico`), 14 px in kompakten Zeilen (`.s3-ico-sm`). Icons erben die Textfarbe; in Zeilen stehen sie in `fg-secondary`, Ordner in `warning-fg`. Keine eigenen Icons, keine gefüllten Varianten, kein Emoji.

Feste Zuordnung: Verbindung `server` (S3-kompatibel) bzw. `cloud` (gehostete Anbieter) · Bucket `database` · Ordner/Präfix `folder` / `folder-open` · Objekt `file`, Archiv `file-archive`, Text `file-text`, verschlüsselt/archiviert `file-lock` · Upload `arrow-up` / `upload` · Download `arrow-down` / `download` · Aktualisieren `refresh-cw` · Wiederholen `rotate-cw` · Pausieren `pause` · Fortsetzen `play` · Abbrechen/Schließen `x` · Löschen `trash-2` · Link/Presigned URL `link` · Pfad kopieren `clipboard-copy` · Kopieren `copy` · Umbenennen `pencil` · Eigenschaften `info` / Panel `panel-right` · Filter `list-filter` · Suche `search` · Laden `loader` · Fehler `circle-x` / `circle-alert` · Warnung `triangle-alert` · Erfolg `circle-check` · Zugriff verweigert `shield-alert` · Versionen `history` · Favorit `star`.

## Layout

Hauptfenster (siehe `AppWindow`): Toolbar 40 px (Zurück/Weiter/Hoch, Breadcrumb, Filter, Primäraktion Hochladen, Icon-Buttons) · links Seitenleiste 240 px mit Verbindungsbaum (180–400 px, verstellbar) · Tab-Leiste je Verbindung/Bucket · Objekttabelle · unten andockbares Transfer-Panel (Strg+J) · rechts andockbares Eigenschaften-Panel (Alt+Enter) · Status-Leiste 24 px. Mindestfenster 1280 × 720: Seitenleiste und Panels behalten ihre Breite, die Tabelle gibt nach; unter 1440 px Breite blendet die Tabelle die ETag-Spalte aus. Keine Breakpoints darunter, kein Hamburger-Menü, keine Touch-Ziele.

## Komponenten verwenden

Alle Komponenten sind reines CSS in `components/bundle.css` mit dem Präfix `s3-` und Zustandsklassen `is-*` (`is-hover`, `is-pressed`, `is-selected`, `is-active`, `is-error`, `is-loading`, `is-disabled`, `is-focus`). Native Pseudoklassen (`:hover`, `:focus-visible`, `:checked`, `:disabled`) funktionieren ebenso; die `is-*`-Klassen braucht Svelte für Zustände, die keine Pseudoklasse kennt (Auswahl, Fehler, Cursorzeile, inaktives Fenster). Jede Komponente hat hier ihre Vorschau und eine Anleitung mit dem Markup und den Regeln. Ohne `bundle.js`: das System ist an kein Framework gebunden, die Svelte-Komponenten übernehmen Markup und Klassen 1:1.

Hinzugefügt über das Briefing hinaus: `AppWindow` (Gesamtfenster als Referenz für das Zusammenspiel), `IconButton` und `Combobox` als eigene Karten, die Fehlerleiste (`s3-banner`) im Fehlerzustand und die Tokens `bg-hover`, `bg-pressed`, `bg-subtle`, `on-accent`, `on-error`, `error-hover`, `skeleton`, `scrim`, `scrollbar-thumb` sowie die Größen `control-*`, `row-height*`, `icon-*` und `statusbar-height`, die die Komponenten brauchen.

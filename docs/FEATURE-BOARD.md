# Feature-Board – S3 Commander

Stand: 13.10.2026. Reihenfolge innerhalb einer Spalte = Priorität. Referenzen auf Screens beziehen
sich auf `design/s3-client-ui-handoff/docs/UI-SPEC.md`.

## In Arbeit

- **Linux-Version:** Die App baut und läuft unter Linux (WebKitGTK). Zugangsdaten liegen im Schlüsselbund über Secret Service (`zbus-secret-service-keyring-store`, GNOME Keyring oder KWallet); ohne erreichbaren Schlüsselbund startet die App trotzdem und meldet es beim Speichern. Die lokale Seite der Zwei-Panel-Ansicht zeigt oben persönlichen Ordner, Dateisystem `/` und eingehängte Datenträger (`/media/<Nutzer>`, `/run/media/<Nutzer>`, `/mnt`); die Pfadlogik der Oberfläche kennt beide Schreibweisen. „Teilen …“ gibt es nur unter Windows, unter Linux bleibt „Presigned URL kopieren“. Die CI prüft Windows und Ubuntu 22.04 (Tests der Zugangsdaten mit GNOME Keyring), Releases enthalten zusätzlich `.deb` und AppImage. **Offen:** auf einem echten Linux-Desktop ausprobieren.

## Als Nächstes

_Nichts._

## Geplant

_Nichts._

## Ideen

- **Dauerhafter Ordner-Sync:** Einen oder mehrere lokale Ordner mit Bucket-Präfixen synchron halten
  (Sync-Aufträge mit Richtung, Ausschlussmustern und Löschregel). Baut auf dem vorhandenen Abgleich auf und braucht:
  Dateiüberwachung (`notify`) plus regelmäßigen Vollscan, Listing im Intervall für die Bucket-Seite, einen
  Sync-Zustand in SQLite (sonst sind Löschungen und Konflikte nicht erkennbar) und Schutzregeln (Löschen
  standardmäßig aus, Stopp bei ungewöhnlich vielen Löschungen, nur stabile Dateien übertragen). Reihenfolge:
  Lokal → Bucket, dann Bucket → Lokal mit Löschungen, zuletzt beidseitig mit Konfliktkopien. Läuft als
  Hintergrundprozess in der Benutzersitzung (Autostart, Infobereich-Symbol, unter Linux optional
  `systemd --user`), nicht als Systemdienst: Ein Dienst käme nicht an die Zugangsdaten im Speicher des
  Benutzers. Ein echter Dienst nur als eigener Server-Modus mit anderer Quelle für Zugangsdaten.
- Gelöschte Objekte anzeigen und wiederherstellen: Objekte, deren neueste Version ein Delete Marker ist, fehlen
  im Listing. Ein Schalter „Gelöschte anzeigen“ (über `ListObjectVersions`) könnte sie einblenden und per Klick
  zurückholen. Bisher geht das nur über die Versionen eines noch sichtbaren Objekts in den Eigenschaften.
- Bucket-Policies, CORS und Lifecycle als Editor.
- Verschlüsselung beim Hochladen wählen (SSE-S3, SSE-KMS, SSE-C) und Object Lock. Angezeigt wird die
  Verschlüsselung schon in den Eigenschaften.
- Vorschau für Bilder, Text und PDF.

## Erledigt

- Fensterweises Laden sehr großer Ordner: Ab 50.000 Einträgen schickt das Backend keine Einträge mehr an
  die Oberfläche, sondern nur den Verweis auf das Listing im SQLite-Cache (bei ausgeschaltetem Cache wird es
  dafür trotzdem geschrieben, aber nie als Cache gültig und nach dem Verlassen des Ordners verworfen). Die
  Tabelle lädt Seiten zu 500 Zeilen um den sichtbaren Bereich und vergisst länger nicht gezeigte (höchstens
  25.000 Zeilen im Speicher). Sortieren und Filtern legen eine sortierte Sicht als temporäre Tabelle an;
  dafür speichert der Cache je Eintrag einen natürlichen Sortierschlüssel (Schema-Version 2, ältere Cache-Dateien
  werden einmal geleert). Gemessen im Debug-Build: Sicht über 500.000 Einträge 1–3 s, jedes Fenster rund 1 ms.
  „Alle auswählen“ bleibt eine Auswahl „alle außer …“; Herunterladen, Kopieren, Löschen und „Pfade kopieren“
  holen die Einträge dafür beim Backend. Bereichsauswahl mit Umschalt lädt fehlende Zeilen vorher. Läuft das
  Listing noch, wird die Sicht alle 2 s aufgefrischt. In der Browser-Vorschau gilt das ab 20.000 Einträgen
  (Ordner `cloudfront/` in `prod-logs-eu`).

- Releases über GitHub Actions: Ein Tag `vX.Y.Z` prüft Tag gegen App-Version, lässt die CI auf Windows und
  Ubuntu laufen und legt einen Release-Entwurf mit NSIS-Installer, portabler EXE, `.deb` und AppImage an.
  Die CI läuft zusätzlich bei jedem Push auf `main`. Erste Version mit Linux-Paketen: 0.2.0.
- Open-Source-Vorbereitung: MIT-Lizenz, README mit Screenshots (`docs/screenshots/`), `CONTRIBUTING.md` mit den
  Projektregeln. Kennung `app.s3commander`, Herausgeber „S3 Commander“, Copyright „S3 Commander contributors“.
- Schutz vor zu weitem Löschen: Rekursive Ordner-Operationen (Löschen, Herunterladen, Kopieren, Umbenennen)
  lösen einen Ordner nur über ein echtes Präfix mit abschließendem `/` auf (`SelectedItem::folder_listing`),
  damit nie Geschwister wie `fotos-alt/` zu `fotos` oder der ganze Bucket mitgetroffen werden.
- Teilen mit Windows: „Teilen …“ im Kontextmenü einer Datei öffnet einen Dialog mit Gültigkeit (1 Stunde, 24 Stunden, 7 Tage) und Hinweis, dass der Link bis zum Ablauf für jeden gilt; „Teilen …“ übergibt den vorsignierten Link mit dem Dateinamen an den Teilen-Dialog von Windows (Mail, Messenger, Umgebungsfreigabe, QR-Code). Auch im Abschnitt „Freigabe“ der Eigenschaften. Das Backend ruft den Dialog über `IDataTransferManagerInterop` auf (einzige `unsafe`-Stelle, `adapters/share_sheet.rs`). Das Browser-Menü von WebView2 (mit dessen „Teilen“ der Oberflächenadresse) ist außer in Eingabefeldern abgeschaltet.
- Release-Build: `npm run tauri build` erzeugt `src-tauri/target/release/s3-commander.exe` (rund 15 MB, eigenständig) und den NSIS-Installer `bundle/nsis/S3 Commander_<Version>_x64-setup.exe` (rund 4 MB, lädt WebView2 bei Bedarf nach). Die Release-EXE startet und öffnet das Hauptfenster. Bei wenig freiem Speicher mit `CARGO_BUILD_JOBS=2` bauen.
- Sync: In der Zwei-Panel-Ansicht gleicht „Abgleichen“ den offenen lokalen Ordner mit dem offenen Bucket-Ordner ab, wahlweise Lokal → Bucket oder Bucket → Lokal. Die Vorschau nennt neue, geänderte (Größe) und neuere Dateien (Toleranz 2 s) samt Summe und unveränderte Dateien; gestartet wird über die normale Transfer-Queue. Bucket → Lokal ersetzt geänderte Dateien und gibt ihnen die Änderungszeit des Objekts, damit der nächste Abgleich sie als unverändert erkennt. Objekte, die lokal fehlen, kann man danach über den gewohnten Löschdialog (mit Rückfrage) entfernen; lokal wird nie gelöscht. Verglichen wird wie bei `aws s3 sync` über Größe und Änderungszeit; die lokale Änderungszeit als Metadatum zu speichern ist entfallen, weil ListObjects keine Metadaten liefert und ein HEAD je Objekt zu teuer wäre.
- Prüfsummen: Uploads lassen jeden Teil vom Dienst prüfen, mit CRC32C (`x-amz-checksum-crc32c`, beim Start angemeldet, beim Zusammenfügen je Teil angegeben), wo der Anbieter es kann, sonst mit `Content-MD5`; ein abgelehnter Teil (`BadDigest`) wird wiederholt. Downloads mit einfachem MD5-ETag werden nach dem letzten Teil mit der Datei verglichen; bei Abweichung prüft ein HEAD die Verschlüsselung (bei SSE-KMS und SSE-C ist der ETag keine MD5), sonst wird die Datei verworfen und der Transfer meldet „Prüfsumme stimmt nicht“. Schalter in Einstellungen › Transfers › Prüfung; Eigenschaften zeigen die Verschlüsselung. Multipart-ETags werden beim Download nicht nachgerechnet.
- Kopieren zwischen Verbindungen: Strg+C/X und Strg+V funktionieren jetzt auch zwischen Tabs verschiedener Verbindungen. Ohne gemeinsamen Dienst liest jeder Teil aus der Quelle in den Speicher und wird sofort ins Ziel hochgeladen (höchstens „Teile parallel“ Teile gleichzeitig, keine Zwischendatei), mit `If-Match` gegen Änderungen der Quelle, Fortsetzen nach Pause über `ListParts` und Upload-Bandbreitenlimit. Verschieben löscht das Original erst nach bestätigter Kopie. Der Multipart-Ablauf ist jetzt für Uploads und diese Kopien derselbe. Benutzer-Metadaten werden zwischen Verbindungen nicht mitkopiert, nur der Content-Type.
- Zwei-Panel-Ansicht (Screen 3): Umschalter „Ansicht: Liste / Zwei-Panel“ in der Werkzeugleiste. Links „Lokal“ mit Pfadleiste (Dieser PC › D: › …), Laufwerken und Ordnern (versteckte und Systemdateien bleiben unsichtbar), rechts der Bucket, dazwischen die Leiste „→ in den Bucket kopieren“ und „← lokal speichern“ (ohne Ordnerauswahl in den offenen lokalen Ordner). Ziehen mit der Maus in beide Richtungen, auf Ordnerzeilen oder in den offenen Ordner, mit Vorschau „1 Element · 412 B / Kopieren nach …“ (Pointer-Events, weil Tauri unter Windows HTML5-Drag-and-Drop abfängt). Lokale Kürzel: Enter, Rücktaste, Alt+↑, F5, Strg+U; Bucket-Kürzel wie Entf wirken dort nicht. Die lokale Seite lädt nach fertigen Downloads neu.
- Listing-Cache (SQLite): Ordner-Listings liegen in `listing-cache.sqlite` (SQLite eingebaut, keine Fremd-DLL). Beim Öffnen, Tab-Wechsel und Zurück/Weiter erscheint sofort der gespeicherte Stand, das frische Listing ersetzt ihn im Hintergrund (Auswahl bleibt, Statusleiste zeigt „Stand … aus dem Cache“); F5 und eigene Änderungen listen frisch. Neue Listings ersetzen alte erst, wenn sie vollständig sind; scheitert das Aktualisieren, bleibt der Cache-Stand mit Fehlerleiste. Einstellungen › Cache: ein- und ausschalten, Umfang, „Cache leeren“. Löschen einer Verbindung entfernt ihre Listings.
- Tabs je Bucket: Tab-Leiste über der Werkzeugleiste mit Status-Punkt der Verbindung und Schließen-x; Strg+T öffnet den offenen Ordner in einem neuen Tab, Strg+W schließt, Strg+Tab/Strg+Umschalt+Tab wechselt, mittlere Maustaste schließt, im Baum „In neuem Tab öffnen“. Jeder Tab merkt sich Ordner, Verlauf und Sortierung; beim Wechsel erscheint der Ordner sofort aus dem Listing-Cache. Trennen oder Löschen einer Verbindung schließt ihre Tabs.
- Transfer-Liste für sehr viele Dateien: Das Backend meldet nur geänderte und entfernte Transfers (`TransferUpdate`), Abschlüsse und Fortschritt gesammelt im 250-ms-Takt; Warteschlange und Takt laufen über Indizes statt über alle Jobs, Meldungen bleiben in Reihenfolge. Die Oberfläche führt Änderungen in einer `Map` mit Versionszähler zusammen, berechnet Zähler, Summen und Wartepositionen in einem Durchlauf und rendert die Liste virtuell (Fehlerzeile jetzt in Zeilenhöhe).
- Einstellungen (Screen 7): Dialog mit Kategorien, Suche und Änderungszähler (Strg+, oder Zahnrad). Transfers: Parallelität, Teilgröße und Multipart-Schwelle, Bandbreitenlimit für Upload und Download (Token-Bucket, gilt sofort auch für laufende Transfers), Konfliktregel beim Herunterladen (Überspringen, Überschreiben wenn neuer, Überschreiben, Umbenennen), Wiederholungen. Gespeichert in `settings.json`. Darstellung (Theme, Dichte, sichtbare Spalten) und „Beim Start verbinden“ lokal. „Jedes Mal fragen“ entfällt (bräuchte einen Dialog mitten im Transfer);
- Filter und Suche: Suchfeld (Strg+F, Esc leert, `*` als Platzhalter) und Filter Typ, Größe, Datum; Auswahl, Zähler und Aktionen sehen nur Treffer, Statusleiste zeigt „von N (gefiltert)“, Leerzustand mit „Filter zurücksetzen“.
- Objekt-Details (Alt+Enter, Knopf, Kontextmenü „Eigenschaften“): Allgemein mit Kopieren, Metadaten bearbeiten (über 5 GiB per Multipart-Copy, Storage Class bleibt), Tags (bis 10), Versionen mit Wiederherstellen und endgültigem Löschen samt Delete Markern, Freigabe per Presigned URL (1 Stunde bis 7 Tage, auch im Kontextmenü), Berechtigungen aus der ACL.
- Verbindung löschen: im Kontextmenü des Baums und im Bearbeiten-Dialog, mit Rückfrage; entfernt Profil und Zugangsdaten, schließt offene Ordner der Verbindung, Bucket-Daten bleiben unberührt.
- Kontextmenü im Verbindungsbaum (Rechtsklick, Umschalt+F10, Menütaste): Verbinden oder Trennen, Neu verbinden, Bearbeiten, Löschen; für Buckets Öffnen und Pfad kopieren.
- Tauri-2-Gerüst, Design-System übernommen (Tokens, Komponenten, Ergänzungen in `fixes.css`).
- Virtuelle Datentabelle für Millionen Zeilen mit Auswahl, Sortierung und Tastatur.
- S3-Kern im Backend: SigV4 (gegen AWS-Testvektoren geprüft), ListBuckets, ListObjectsV2, Anbieter-Vorlagen und Eigenheiten.
- Verbindungsprofile mit Zugangsdaten im Windows-Anmeldeinformationsspeicher bzw. unter Linux im Schlüsselbund (Secret Service).
- Verbindungsdialog (Screen 1) mit Vorlagen, Erkennung der Vorlage aus der Endpoint-URL, optionaler Region (aus der URL abgeleitet) und Prüfung auf Widersprüche.
- Hauptfenster (Screen 2, 6a–6c): Verbindungsbaum, Navigation mit Verlauf, gestreamtes Listing mit Abbruch, Fehlerleiste.
- Upload-Engine: einzelner PUT und Multipart, Streaming von der Platte, parallele Teile, Wiederholung vorübergehender Fehler, Pause, Fortsetzen über `UploadId` + `ListParts`, Abbruch verwirft den Upload auf dem Server.
- Transfer-Queue (Screen 4): eingeklappte Leiste, Panel mit Tabs, Summen, Fehlerzeile mit „Erneut versuchen“, Strg+J, Kurzinfo in der Statusleiste.
- Hochladen per Dateidialog (Strg+U) in den offenen Ordner; der Ordner lädt nach dem Upload neu.
- Drag and Drop aus dem Windows-Explorer: Dateien und Ordner in den offenen Ordner oder auf eine Ordnerzeile ziehen, mit Hervorhebung des Ziels und Drag-Vorschau; Ordner werden rekursiv hochgeladen.
- Download-Engine: parallele Range-Requests direkt in eine Teildatei (`.s3part`), Fortsetzen nach Pause und Fehler, ETag-Prüfung gegen geänderte Objekte; sichere Windows-Dateinamen aus beliebigen Keys; bei vorhandenen Dateien gilt die Konfliktregel aus den Einstellungen (Standard: nummeriert umbenennen).
- Kontextmenü in der Objektliste (Rechtsklick, Umschalt+F10, Menütaste): Öffnen, Herunterladen, Kopieren, Ausschneiden, Einfügen, Umbenennen, Pfad kopieren, Neuer Ordner, Löschen; auf freier Fläche Einfügen, Neuer Ordner, Hochladen, Aktualisieren. Eigenschaften und Presigned URL siehe Objekt-Details.
- Kopieren und Verschieben (Strg+C, Strg+X, Strg+V) innerhalb einer Verbindung: serverseitige Kopien in der Transfer-Queue (über 5 GiB per Multipart-Copy), Verschieben löscht jedes Original erst nach bestätigter Kopie, belegte Namen werden nummeriert, Hinweis in der Statusleiste.
- Nach Uploads und Kopien lädt der offene Ordner auch dann neu, wenn ein neuer Unterordner entstanden ist.
- Neuer Ordner (Knopf) und Umbenennen (F2): Namensdialog mit sofortiger Prüfung, Konflikterkennung; Umbenennen kopiert serverseitig (über 5 GiB per Multipart-Copy) und löscht die Originale erst, wenn alle Kopien geklappt haben.
- Löschen (Entf und Knopf): Bestätigungsdialog nennt Ziel und Menge und den Versionierungsstand; gelöscht werden genau die Keys der Vorschau, in Paketen zu 1.000 mit Fortschritt, Abbrechen und Liste abgelehnter Objekte. In versionierten Buckets bleiben ältere Versionen erhalten.
- Herunterladen (Strg+D und Knopf): Auswahl in einen gewählten Zielordner, Ordner rekursiv mit Struktur; Transfer-Queue zeigt Richtung, Ziel und Tempo getrennt nach Upload und Download.
- Zeitlimit gilt je Warten auf Daten statt für die ganze Anfrage, damit große Teile auch über langsame Leitungen durchlaufen.

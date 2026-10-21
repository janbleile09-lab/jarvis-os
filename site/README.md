# JARVIS OS · Staff Board v2 — Weboberfläche

Statische Oberfläche für das Staff Board. Kein Build, kein npm, kein Framework:
drei Dateien plus Konfiguration, direkt auf GitHub Pages lauffähig.

```
site/
  index.html    Gerüst, Login-Gate, sechs Ansichten
  app.js        Logik: Zugang, Polling, RPCs, Darstellung
  styles.css    Gestaltung (dunkel, Systemschrift, iPhone-tauglich)
  config.js     Supabase-URL + Publishable Key
```

## Veröffentlichen

1. Dateien aus `site/` in den Pages-Zweig legen (Wurzel oder Unterordner, relative Pfade).
2. In Supabase unter *Authentication → URL Configuration* die Pages-URL als
   **Site URL** und als **Redirect URL** eintragen, sonst landet der Anmelde-Link falsch.
3. Fertig. Es gibt keinen Build-Schritt und keine Abhängigkeiten außer
   `@supabase/supabase-js@2` von jsDelivr (ESM, im Browser geladen).

Lokal prüfen:

```sh
cd site && python3 -m http.server 8080
# http://127.0.0.1:8080
```

## Zugangsmodell

Der Gate ist absichtlich streng und in dieser Reihenfolge verdrahtet:

1. **Keine Session** → nur die Login-Ansicht. Kein Board-Aufruf, keine Daten.
2. **Session, aber kein Mitglied** → Zugangscode (`claim_owner`), solange kein
   Inhaber existiert; sonst „Kein Zugang".
3. **Mitglied, Gerät nicht freigeschaltet** → ausschließlich Geräteprüfung:
   Sicherheitsfrage setzen (falls keine existiert) → `register_device` →
   `answer_device`. Board-Inhalte werden in diesem Zustand nicht geladen.
4. **Mitglied + freigeschaltetes Gerät** → Board.

Das Gerätetoken ist 32 Byte Zufall als Hex in `localStorage`
(`jarvis_device_token`) und geht bei **jedem** RPC als Header `x-device-token` mit.
Der Server prüft es in `staff.device_ok()`; ohne passendes Gerät liefert
`staff.board()` nur `{ok:false, reason:'device_not_trusted'}`.

## Verdrahtete RPCs (Schema `staff`)

| RPC | Zweck in der Oberfläche |
| --- | --- |
| `board()` | einzige Datenquelle des Boards; alle 5 s, pausiert bei `document.hidden` |
| `device_status()` | Gate-Entscheidung: `authenticated`, `member`, `trusted`, `has_question`, `owner_claimed` |
| `claim_owner(p_code)` | Erstübernahme des Inhabers |
| `set_security_question(p_question, p_answer)` | Sicherheitsfrage setzen/ändern |
| `register_device(p_label, p_ua, p_token)` | Gerät anlegen, Frage abholen |
| `answer_device(p_device, p_answer)` | Gerät freischalten (3 Versuche, dann 15 min Sperre) |
| `revoke_device(p_device)` | Gerät widerrufen (Zweiklick-Bestätigung) |
| `decide_approval(p_id, p_decision, p_note)` | Freigaben: `approved`, `denied`, `withdrawn` |
| `instruct(p_target, p_body)` | Anweisung an einen Agenten |
| `upsert_task(p_id, …)` | Pausieren (`blocked`) und Neu starten (`todo`, Fortschritt 0) |
| `update_readiness(p_key, p_score, p_note, p_url)` | Marktreife-Score mit Evidenzpflicht |
| `set_setting(p_key, p_value)` | Budgets und Nacht-Policy als JSON |

Tabellen werden nie direkt gelesen oder geschrieben — es gibt keine
`.from(...)`-Aufrufe. `board()` ist der einzige Lese-RPC.

## Ansichten

1. **Übersicht** — Organigramm (Inhaber → COO → Bereiche) aus `agents`, darunter
   Live-Karten je Agent: aktuelle Karte, Schritt, Fortschritt, Heartbeat-Alter,
   Token und Kosten des Tages.
2. **Live-Board** — je Agent: offene Karten, Verlauf aus `events`,
   Anweisungsfeld (`instruct`), „Pausieren" und „Neu starten".
3. **Freigaben** — offene Entscheidungen mit Kosten, Risiko, Frist und
   Standard-Entscheidung; „Mit Anweisung" entscheidet und schickt den Text
   zusätzlich per `instruct` an den anfragenden Agenten. Darunter die
   Entscheidungen der letzten 7 Tage.
4. **Analytik** — Karten heute, Nachtfortschritt 22–07, Kosten heute gegen
   Tagesbudget, blockierte Karten; SVG-Diagramm (Karten als Balken, Token als
   Linie) aus `metrics`; Tabelle je Agent.
5. **Marktreife** — gewichteter Score als Ring, Kriterienliste mit Evidenz;
   Änderung nur mit Evidenztext, sonst keine Speicherung.
6. **Watchdog & Einstellungen** — Watchdog-Checks, Vorfälle, Geräteliste mit
   Widerruf, Sicherheitsfrage ändern, `settings` als JSON editierbar, Abmelden.

## Verhalten und Grenzen

- **Polling:** `board()` alle 5000 ms, übersprungen bei `document.hidden`;
  beim Zurückkehren auf den Tab wird sofort einmal geladen. Läuft ein Aufruf
  noch, wird der nächste übersprungen (kein Stau).
- **Eingaben überleben Aktualisierungen:** Texte in Anweisungs-, Notiz-,
  Evidenz- und JSON-Feldern liegen in einem Entwurfsspeicher und werden beim
  Neuzeichnen wiederhergestellt. Während der Fokus in einem Textfeld liegt,
  wird die Ansicht nicht neu gezeichnet (Nachholen beim Verlassen).
- **Keine erfundenen Zahlen:** Fehlen Daten, steht „Noch keine Daten" bzw.
  „—" in der Oberfläche. Kennzahlen werden aus `metrics`/`agents` gerechnet,
  nicht geschätzt.
- **Kein `innerHTML` mit Fremddaten:** Agenten-, Aufgaben- und Ereignistexte
  werden ausschließlich über `textContent` gesetzt.
- **CSP:** siehe `index.html` — `script-src` nur `self` und jsDelivr,
  `connect-src` nur `self` und die Supabase-URL, `form-action 'none'`.
  Deshalb keine `<form>`-Elemente und keine Inline-Handler; alle Ereignisse
  laufen über `addEventListener`.
- **Keine Geheimnisse im Code:** `config.js` enthält nur URL und Publishable
  Key. Kein Service-Key, kein Secret, keine Zugangsdaten.
- **Antwortfelder sind sichtbar:** Die Antwort auf die Sicherheitsfrage wird
  im Klartext getippt (kein maskiertes Feld), damit sie nicht vertippt wird —
  sie ist ein Wort, kein Geheimnis mit Zeichenvorrat.

## Bewusst offen gelassen

- **Anlegen neuer Karten** — `upsert_task` wird nur zum Pausieren und Neu
  Anstoßen bestehender Karten genutzt. Ein Formular zum Anlegen fehlt; Karten
  entstehen weiterhin beim Daemon/Agenten.
- **Prioritäten ändern** — `upsert_task` kann `p_priority` nicht setzen
  (Signatur kennt den Parameter nicht).
- **Subagent-Detailansicht** — `board()` liefert keine Subagent-Daten; die
  Oberfläche zeigt nur Karten, Ereignisse und Heartbeat.
- **Verlaufsfenster** — es gibt keine Paginierung. Sichtbar sind, was `board()`
  liefert: 60 Karten, 40 Freigaben, 40 Ereignisse, 25 Vorfälle, 7 Tage Metriken.
- **Diagramm über 7 Tage hinaus** — die RPC begrenzt `metrics` auf 7 Tage,
  deshalb zeigt das Diagramm maximal 14 Tagesspalten, realistisch 7.
- **Benachrichtigungen** — keine Push-Nachrichten, keine Töne; der Zustand
  ergibt sich aus dem Polling.
- **Dark Mode** — nur dunkel. Kein Theme-Umschalter, `color-scheme: dark`.

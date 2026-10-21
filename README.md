# JARVIS OS — Staff Board v2

Steuerpult für Jans Agenten-Firma: Organigramm, Live-Board, Freigaben, Analytik, Marktreife,
Watchdogs. Öffentlich erreichbar, aber ohne freigeschaltetes Gerät liefert die Seite keine Daten.

- `site/` — statische Oberfläche (GitHub Pages), holt alles über SECURITY-DEFINER-RPCs
- `staffd/` — Daemon auf dem Mac (Hermes ↔ Supabase, Watchdog, Metriken)
- `supabase/migrations/` — Schema, RLS, RPCs, Seed
- `CONTRACT.md` — verbindlicher Bauvertrag

Sicherheit: Login per E-Mail-Link (Supabase Auth), danach Sicherheitsfrage je neuem Gerät.
Tabellen sind für den Menschen gesperrt; Lesen/Schreiben nur über RPCs mit Gerätetoken.
Kein service_role-Key im Browser oder im Daemon.

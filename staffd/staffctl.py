#!/usr/bin/env python3
"""staffctl — Werkzeug fuer die Agenten (Hermes-Profile).

Ein Agent, der etwas darf-will, fragt nicht im Chat, sondern legt eine Freigabe an.
Der Mensch entscheidet im Staff Board, staffd fuehrt aus.

Beispiele:
  staffctl ask --agent charlie --kind subagents --title "3 Subagents für Cache-Test" \
      --question "Drei Hypothesen parallel prüfen?" --recommendation "genehmigen" \
      --cost-tokens 180000 --cost-eur 1.60 --expires-hours 6 --default approve
  staffctl event --agent peter --kind progress --message "Deploy vorbereitet, warte auf Freigabe"
  staffctl task --agent peter --title "Einkaufsliste live" --status running --step "Schritt 2/5"
  staffctl status

Zugang: liest ~/.jarvis-os/secrets.env (Agent-User, Rolle 'agent').
Der Agent kann Freigaben ANLEGEN, aber nicht entscheiden — das ist in der Datenbank so
verdrahtet, nicht nur hier.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

SECRETS = os.path.expanduser("~/.jarvis-os/secrets.env")


def load_env(path: str = SECRETS) -> dict:
    env = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


class Api:
    def __init__(self, env: dict | None = None):
        self.env = env or load_env()
        self.url = self.env["SUPABASE_URL"].rstrip("/")
        self.anon = self.env["SUPABASE_ANON_KEY"]
        self.token = None

    def _req(self, method: str, path: str, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        hdrs = {
            "apikey": self.anon,
            "Authorization": f"Bearer {self.token or self.anon}",
            "Content-Type": "application/json",
            "Accept-Profile": "staff",
            "Content-Profile": "staff",
        }
        hdrs.update(headers or {})
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode()
                return resp.status, (json.loads(raw) if raw.strip() else None)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            raise SystemExit(f"HTTP {exc.code}: {raw[:400]}")

    def login(self):
        status, data = self._req(
            "POST",
            "/auth/v1/token?grant_type=password",
            {"email": self.env["STAFF_AGENT_EMAIL"], "password": self.env["STAFF_AGENT_PASSWORD"]},
        )
        self.token = data["access_token"]
        return self

    def insert(self, table: str, row: dict):
        return self._req("POST", f"/rest/v1/{table}?select=*", row,
                         {"Prefer": "return=representation"})[1]

    def patch(self, table: str, query: str, row: dict):
        return self._req("PATCH", f"/rest/v1/{table}?{query}&select=*", row,
                         {"Prefer": "return=representation"})[1]

    def select(self, table: str, query: str = "select=*"):
        return self._req("GET", f"/rest/v1/{table}?{query}")[1] or []


def cmd_ask(api: Api, args) -> int:
    expires = None
    if args.expires_hours:
        expires = (datetime.now(timezone.utc) + timedelta(hours=args.expires_hours)).isoformat()
    row = {
        "requested_by": args.agent,
        "kind": args.kind,
        "title": args.title,
        "question": args.question,
        "recommendation": args.recommendation,
        "cost_tokens": args.cost_tokens,
        "cost_eur": args.cost_eur,
        "risk": args.risk,
        "default_decision": args.default,
        "expires_at": expires,
    }
    created = api.insert("approvals", row)
    if not created:
        print("Freigabe nicht angelegt (Rechte prüfen).", file=sys.stderr)
        return 1
    approval = created[0]
    api.insert("events", {"agent_key": args.agent, "kind": "approval",
                          "message": f"Freigabe angefragt: {args.title}"})
    print(f"Freigabe angelegt: {approval['id']}")
    if expires:
        print(f"Frist: {expires} (Standard danach: {args.default})")
    print("Jan sieht sie im Staff Board unter Freigaben.")
    return 0


def cmd_event(api: Api, args) -> int:
    api.insert("events", {"agent_key": args.agent, "kind": args.kind, "message": args.message})
    print("Event geschrieben.")
    return 0


def cmd_task(api: Api, args) -> int:
    if args.id:
        rows = api.patch("tasks", f"id=eq.{args.id}", {
            "status": args.status, "current_step": args.step,
            "progress": args.progress, "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        print(f"Karte aktualisiert: {rows[0]['id'] if rows else args.id}")
        return 0
    row = {
        "agent_key": args.agent, "title": args.title, "detail": args.detail,
        "status": args.status, "current_step": args.step, "progress": args.progress or 0,
    }
    created = api.insert("tasks", row)
    print(f"Karte angelegt: {created[0]['id'] if created else '—'}")
    return 0


def cmd_status(api: Api, args) -> int:
    open_approvals = api.select("approvals", "status=eq.open&select=id,title,requested_by,created_at")
    tasks = api.select("tasks", "status=neq.done&select=id,agent_key,title,status")
    print(f"Offene Freigaben: {len(open_approvals)}")
    for row in open_approvals:
        print(f"  · {row['requested_by']}: {row['title']}")
    print(f"Offene Karten: {len(tasks)}")
    for row in tasks:
        print(f"  · [{row['status']}] {row['agent_key']}: {row['title']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Staff-Board-Werkzeug für Agenten")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ask", help="Freigabe anfragen")
    p.add_argument("--agent", required=True)
    p.add_argument("--kind", default="other",
                   choices=["subagents", "deploy", "purchase", "delete", "external", "other"])
    p.add_argument("--title", required=True)
    p.add_argument("--question", required=True)
    p.add_argument("--recommendation")
    p.add_argument("--cost-tokens", type=int)
    p.add_argument("--cost-eur", type=float)
    p.add_argument("--risk", default="low", choices=["low", "medium", "high"])
    p.add_argument("--expires-hours", type=float, default=6)
    p.add_argument("--default", default="approve", choices=["approve", "deny"])
    p.set_defaults(func=cmd_ask)

    p = sub.add_parser("event", help="Ereignis ins Board schreiben")
    p.add_argument("--agent", required=True)
    p.add_argument("--kind", default="note")
    p.add_argument("--message", required=True)
    p.set_defaults(func=cmd_event)

    p = sub.add_parser("task", help="Karte anlegen oder aktualisieren")
    p.add_argument("--agent")
    p.add_argument("--id")
    p.add_argument("--title")
    p.add_argument("--detail")
    p.add_argument("--status", default="todo",
                   choices=["todo", "scheduled", "running", "blocked", "review", "done"])
    p.add_argument("--step")
    p.add_argument("--progress", type=int)
    p.set_defaults(func=cmd_task)

    p = sub.add_parser("status", help="offene Freigaben und Karten zeigen")
    p.set_defaults(func=cmd_status)

    args = parser.parse_args()
    api = Api().login()
    return args.func(api, args)


if __name__ == "__main__":
    raise SystemExit(main())

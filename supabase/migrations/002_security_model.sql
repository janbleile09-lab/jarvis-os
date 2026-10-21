-- JARVIS OS — Sicherheitsmodell, Fassung 2
--
-- Grund fuer die Aenderung: PostgREST stellt den Header `request.headers` bei
-- Tabellen-Abfragen nicht bereit, RLS-Policies koennen das Geraetetoken dort also nicht
-- pruefen (verifiziert am 21.10.2026: identische Policy liefert mit `auth.uid()` Zeilen,
-- mit Header-Pruefung null Zeilen, waehrend dieselbe Pruefung per RPC true ergibt).
--
-- Deshalb: der Mensch liest und schreibt AUSSCHLIESSLICH ueber SECURITY-DEFINER-RPCs,
-- die das Geraet pruefen. Tabellenrechte hat nur noch der Daemon (role=agent).
-- Damit ist selbst eine fehlerhafte Policy kein Datenleck: ohne Tabellenrecht keine Zeile.

-- 1) Menschen raus aus den Tabellen
revoke all on all tables in schema staff from authenticated;
revoke all on all sequences in schema staff from authenticated;

-- 2) Menschliche Policies entfernen (nur noch Daemon-Policies)
drop policy if exists agents_read on staff.agents;
drop policy if exists agents_write on staff.agents;
drop policy if exists tasks_read on staff.tasks;
drop policy if exists tasks_write on staff.tasks;
drop policy if exists hb_read on staff.heartbeats;
drop policy if exists events_read on staff.events;
drop policy if exists approvals_read on staff.approvals;
drop policy if exists approvals_decide on staff.approvals;
drop policy if exists instr_read on staff.instructions;
drop policy if exists incidents_read on staff.incidents;
drop policy if exists wd_read on staff.watchdog_checks;
drop policy if exists metrics_read on staff.metrics_hourly;
drop policy if exists readiness_read on staff.readiness;
drop policy if exists readiness_write on staff.readiness;
drop policy if exists settings_read on staff.settings;
drop policy if exists settings_write on staff.settings;
drop policy if exists members_self on staff.members;
drop policy if exists devices_own on staff.devices;

-- 3) Daemon-Policies (role=agent, per auth.uid() im members-Verzeichnis)
drop policy if exists daemon_read on staff.agents;
create policy daemon_read on staff.agents for select to authenticated using (staff.is_agent());
drop policy if exists daemon_tasks on staff.tasks;
create policy daemon_tasks on staff.tasks for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_hb on staff.heartbeats;
create policy daemon_hb on staff.heartbeats for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_events on staff.events;
create policy daemon_events on staff.events for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_approvals on staff.approvals;
create policy daemon_approvals on staff.approvals for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_instr on staff.instructions;
create policy daemon_instr on staff.instructions for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_incidents on staff.incidents;
create policy daemon_incidents on staff.incidents for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_wd on staff.watchdog_checks;
create policy daemon_wd on staff.watchdog_checks for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_metrics on staff.metrics_hourly;
create policy daemon_metrics on staff.metrics_hourly for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_readiness on staff.readiness;
create policy daemon_readiness on staff.readiness for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_settings on staff.settings;
create policy daemon_settings on staff.settings for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_members on staff.members;
create policy daemon_members on staff.members for select to authenticated using (staff.is_agent());

-- 4) Ein Lese-RPC fuer das gesamte Board (ein Roundtrip statt sieben Abfragen)
create or replace function staff.board() returns jsonb
language plpgsql security definer set search_path = staff, public as $$
declare res jsonb;
begin
  if not staff.device_ok() then
    return jsonb_build_object('ok', false, 'reason', 'device_not_trusted');
  end if;
  select jsonb_build_object(
    'ok', true,
    'now', now(),
    'agents', coalesce((select jsonb_agg(jsonb_build_object(
        'key', a.key, 'name', a.name, 'role', a.role, 'level', a.level,
        'personality', a.personality, 'mandate', a.mandate, 'limits', a.limits,
        'model', a.model, 'budget_eur_day', a.budget_eur_day,
        'reports_to', a.reports_to, 'sort', a.sort,
        'last_seen', h.last_seen, 'status', h.status,
        'tokens_today', h.tokens_today, 'cost_eur_today', h.cost_eur_today,
        'meta', h.meta
      ) order by a.sort)
      from staff.agents a left join staff.heartbeats h on h.agent_key = a.key
      where a.active), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'agent_key', t.agent_key, 'title', t.title, 'detail', t.detail,
        'status', t.status, 'progress', t.progress, 'current_step', t.current_step,
        'priority', t.priority, 'updated_at', t.updated_at
      ) order by t.priority, t.updated_at desc)
      from (select * from staff.tasks
             where status <> 'done' or finished_at > now() - interval '24 hours'
             order by updated_at desc limit 60) t), '[]'::jsonb),
    'approvals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', ap.id, 'requested_by', ap.requested_by, 'kind', ap.kind, 'title', ap.title,
        'question', ap.question, 'recommendation', ap.recommendation,
        'cost_tokens', ap.cost_tokens, 'cost_eur', ap.cost_eur, 'risk', ap.risk,
        'status', ap.status, 'default_decision', ap.default_decision,
        'expires_at', ap.expires_at, 'decided_at', ap.decided_at,
        'decision_note', ap.decision_note, 'created_at', ap.created_at
      ) order by ap.created_at desc)
      from (select * from staff.approvals order by created_at desc limit 40) ap), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'ts', e.ts, 'agent_key', e.agent_key, 'kind', e.kind, 'message', e.message
      ) order by e.ts desc)
      from (select * from staff.events order by ts desc limit 40) e), '[]'::jsonb),
    'incidents', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'ts', i.ts, 'severity', i.severity, 'source', i.source,
        'summary', i.summary, 'action_taken', i.action_taken,
        'needs_jan', i.needs_jan, 'resolved_at', i.resolved_at
      ) order by i.ts desc)
      from (select * from staff.incidents order by ts desc limit 25) i), '[]'::jsonb),
    'watchdog', coalesce((select jsonb_agg(jsonb_build_object(
        'check_key', w.check_key, 'status', w.status, 'detail', w.detail,
        'latency_ms', w.latency_ms, 'ts', w.ts
      ))
      from (select distinct on (check_key) * from staff.watchdog_checks
             order by check_key, ts desc) w), '[]'::jsonb),
    'metrics', coalesce((select jsonb_agg(jsonb_build_object(
        'hour', m.hour, 'agent_key', m.agent_key, 'tasks_done', m.tasks_done,
        'tokens', m.tokens, 'cost_eur', m.cost_eur, 'blocked_minutes', m.blocked_minutes
      ) order by m.hour)
      from (select * from staff.metrics_hourly where hour > now() - interval '7 days') m), '[]'::jsonb),
    'readiness', coalesce((select jsonb_agg(jsonb_build_object(
        'key', r.key, 'label', r.label, 'weight', r.weight, 'score', r.score,
        'evidence_url', r.evidence_url, 'evidence_note', r.evidence_note, 'updated_at', r.updated_at
      ) order by r.weight desc) from staff.readiness r), '[]'::jsonb),
    'readiness_score', (select round(sum(weight * score) / 5 * 100, 1) from staff.readiness),
    'settings', coalesce((select jsonb_object_agg(key, value) from staff.settings), '{}'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'label', d.label, 'status', d.status,
        'created_at', d.created_at, 'trusted_at', d.trusted_at, 'last_seen_at', d.last_seen_at
      ) order by d.created_at desc) from staff.devices d where d.user_id = auth.uid()), '[]'::jsonb),
    'instructions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'target', x.target, 'body', x.body, 'status', x.status,
        'created_at', x.created_at, 'result', x.result
      ) order by x.created_at desc)
      from (select * from staff.instructions order by created_at desc limit 20) x), '[]'::jsonb)
  ) into res;
  update staff.devices set last_seen_at = now()
    where user_id = auth.uid() and status = 'trusted'
      and token_hash = encode(extensions.digest(staff.device_token(), 'sha256'), 'hex');
  return res;
end $$;

-- 5) Schreib-RPCs der Oberflaeche

create or replace function staff.decide_approval(p_id uuid, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = staff, public as $$
declare a staff.approvals;
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  if p_decision not in ('approved','denied','withdrawn') then
    return jsonb_build_object('ok', false, 'reason', 'bad_decision');
  end if;
  select * into a from staff.approvals where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if a.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;
  update staff.approvals
     set status = p_decision, decided_at = now(), decided_by = auth.uid(), decision_note = p_note
   where id = p_id;
  insert into staff.events(agent_key, kind, message)
    values (a.requested_by, 'approval', 'Freigabe ' || p_decision || ': ' || a.title);
  return jsonb_build_object('ok', true);
end $$;

create or replace function staff.instruct(p_target text, p_body text)
returns jsonb language plpgsql security definer set search_path = staff, public as $$
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  if not exists (select 1 from staff.agents where key = p_target) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_agent');
  end if;
  if length(btrim(coalesce(p_body,''))) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'too_short');
  end if;
  insert into staff.instructions(target, body) values (p_target, btrim(p_body));
  insert into staff.events(agent_key, kind, message)
    values (p_target, 'instruction', 'Anweisung von Jan: ' || left(btrim(p_body), 200));
  return jsonb_build_object('ok', true);
end $$;

create or replace function staff.update_readiness(p_key text, p_score int, p_note text, p_url text default null)
returns jsonb language plpgsql security definer set search_path = staff, public as $$
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  if p_score < 0 or p_score > 5 then return jsonb_build_object('ok', false, 'reason', 'bad_score'); end if;
  update staff.readiness
     set score = p_score, evidence_note = p_note, evidence_url = p_url, updated_at = now()
   where key = p_key;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_key'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function staff.set_setting(p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = staff, public as $$
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  insert into staff.settings(key, value, updated_at) values (p_key, p_value, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Aufgaben anlegen/aendern aus der Oberflaeche (Jan darf eingreifen)
create or replace function staff.upsert_task(p_id uuid, p_agent text, p_title text, p_detail text,
                                             p_status text default 'todo', p_progress int default 0,
                                             p_step text default null)
returns jsonb language plpgsql security definer set search_path = staff, public as $$
declare t staff.tasks;
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  if p_id is null then
    insert into staff.tasks(agent_key, title, detail, status, progress, current_step)
      values (p_agent, p_title, p_detail, p_status, coalesce(p_progress,0), p_step) returning * into t;
  else
    update staff.tasks set title = coalesce(p_title, title), detail = coalesce(p_detail, detail),
           status = coalesce(p_status, status), progress = coalesce(p_progress, progress),
           current_step = coalesce(p_step, current_step), updated_at = now()
     where id = p_id returning * into t;
  end if;
  insert into staff.events(agent_key, kind, message)
    values (p_agent, 'task', 'Jan hat Karte geändert: ' || coalesce(t.title,''));
  return jsonb_build_object('ok', true, 'id', t.id);
end $$;

grant execute on function staff.board(), staff.decide_approval(uuid,text,text),
  staff.instruct(text,text), staff.update_readiness(text,int,text,text),
  staff.set_setting(text,jsonb), staff.upsert_task(uuid,text,text,text,text,int,text)
  to authenticated;

-- JARVIS OS — Ausbaustufe 2: Analytik, Folgearbeit, Sprachbefehl, Tafel, Agentenkontakt
--
-- Alles additiv: bestehende Felder von staff.board() bleiben unverändert, es kommen neue
-- dazu. Die Oberfläche darf nicht brechen, wenn ein Feld fehlt.

-- ---------------------------------------------------------------- Freigaben: Folgearbeit

alter table staff.approvals drop constraint if exists approvals_kind_check;
alter table staff.approvals add constraint approvals_kind_check
  check (kind in ('subagents','deploy','purchase','delete','external','followup','other'));

alter table staff.approvals add column if not exists estimate_minutes int;
alter table staff.approvals add column if not exists after_task_id uuid;
alter table staff.approvals add column if not exists after_task_title text;

-- ---------------------------------------------------------------- Analytik feiner

alter table staff.metrics_hourly add column if not exists tokens_in bigint default 0;
alter table staff.metrics_hourly add column if not exists tokens_out bigint default 0;
alter table staff.metrics_hourly add column if not exists tokens_cache bigint default 0;
alter table staff.metrics_hourly add column if not exists sessions int default 0;
alter table staff.metrics_hourly add column if not exists events int default 0;

-- ---------------------------------------------------------------- Tafel (Schwarzes Brett)

create table if not exists staff.blackboard (
  id         int primary key default 1 check (id = 1),
  body       text not null,
  updated_by text not null default 'jarvis',
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- Sprachbefehl

create table if not exists staff.voice_notes (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  mime         text,
  duration_ms  int,
  audio        text,                       -- base64, wird nach dem Transkribieren geleert
  transcript   text,
  status       text not null default 'queued'
               check (status in ('queued','transcribing','done','failed')),
  error        text,
  processed_at timestamptz
);
create index if not exists voice_status_idx on staff.voice_notes(status, created_at);

-- ---------------------------------------------------------------- Agenten-Kontakt

create table if not exists staff.messages (
  id           uuid primary key default gen_random_uuid(),
  ts           timestamptz not null default now(),
  from_agent   text not null,
  to_agent     text not null,
  body         text not null,
  delivered_at timestamptz
);
create index if not exists messages_to_idx on staff.messages(to_agent, delivered_at);

-- ---------------------------------------------------------------- Fremddienste (Antigravity)

create table if not exists staff.service_usage (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  service text not null,
  metric  text not null,
  value   numeric,
  detail  text
);
create index if not exists service_usage_idx on staff.service_usage(service, metric, ts desc);

-- ---------------------------------------------------------------- Besuch / Digest

alter table staff.members add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------- RLS für die neuen Tabellen

alter table staff.blackboard    enable row level security;
alter table staff.voice_notes   enable row level security;
alter table staff.messages      enable row level security;
alter table staff.service_usage enable row level security;

grant select, insert, update, delete on all tables in schema staff to authenticated;
grant usage, select on all sequences in schema staff to authenticated;

drop policy if exists daemon_blackboard on staff.blackboard;
create policy daemon_blackboard on staff.blackboard for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_voice on staff.voice_notes;
create policy daemon_voice on staff.voice_notes for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_messages on staff.messages;
create policy daemon_messages on staff.messages for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());
drop policy if exists daemon_usage on staff.service_usage;
create policy daemon_usage on staff.service_usage for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());

-- ---------------------------------------------------------------- board() neu, additiv

create or replace function staff.board() returns jsonb
language plpgsql security definer set search_path = staff, public as $$
declare res jsonb; uid uuid := auth.uid();
begin
  if not staff.device_ok() then
    return jsonb_build_object('ok', false, 'reason', 'device_not_trusted');
  end if;
  select jsonb_build_object(
    'ok', true, 'now', now(),
    'agents', coalesce((select jsonb_agg(jsonb_build_object(
        'key', a.key, 'name', a.name, 'role', a.role, 'level', a.level,
        'personality', a.personality, 'mandate', a.mandate, 'limits', a.limits,
        'model', a.model, 'budget_eur_day', a.budget_eur_day,
        'reports_to', a.reports_to, 'sort', a.sort,
        'last_seen', h.last_seen, 'status', h.status,
        'tokens_today', h.tokens_today, 'cost_eur_today', h.cost_eur_today, 'meta', h.meta
      ) order by a.sort)
      from staff.agents a left join staff.heartbeats h on h.agent_key = a.key where a.active), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'agent_key', t.agent_key, 'title', t.title, 'detail', t.detail,
        'status', t.status, 'progress', t.progress, 'current_step', t.current_step,
        'priority', t.priority, 'updated_at', t.updated_at, 'finished_at', t.finished_at)
        order by t.priority, t.updated_at desc)
      from (select * from staff.tasks where status <> 'done' or finished_at > now() - interval '24 hours'
             order by updated_at desc limit 60) t), '[]'::jsonb),
    'approvals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', ap.id, 'requested_by', ap.requested_by, 'kind', ap.kind, 'title', ap.title,
        'question', ap.question, 'recommendation', ap.recommendation,
        'cost_tokens', ap.cost_tokens, 'cost_eur', ap.cost_eur, 'risk', ap.risk,
        'status', ap.status, 'default_decision', ap.default_decision, 'expires_at', ap.expires_at,
        'decided_at', ap.decided_at, 'decision_note', ap.decision_note, 'created_at', ap.created_at,
        'estimate_minutes', ap.estimate_minutes, 'after_task_id', ap.after_task_id,
        'after_task_title', ap.after_task_title, 'applied_at', ap.applied_at)
        order by ap.created_at desc)
      from (select * from staff.approvals order by created_at desc limit 40) ap), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'ts', e.ts, 'agent_key', e.agent_key, 'kind', e.kind, 'message', e.message)
        order by e.ts desc) from (select * from staff.events order by ts desc limit 60) e), '[]'::jsonb),
    'incidents', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'ts', i.ts, 'severity', i.severity, 'source', i.source, 'summary', i.summary,
        'action_taken', i.action_taken, 'needs_jan', i.needs_jan, 'resolved_at', i.resolved_at)
        order by i.ts desc) from (select * from staff.incidents order by ts desc limit 25) i), '[]'::jsonb),
    'watchdog', coalesce((select jsonb_agg(jsonb_build_object(
        'check_key', w.check_key, 'status', w.status, 'detail', w.detail,
        'latency_ms', w.latency_ms, 'ts', w.ts))
      from (select distinct on (check_key) * from staff.watchdog_checks order by check_key, ts desc) w), '[]'::jsonb),
    'metrics', coalesce((select jsonb_agg(jsonb_build_object(
        'hour', m.hour, 'agent_key', m.agent_key, 'tasks_done', m.tasks_done,
        'tokens', m.tokens, 'cost_eur', m.cost_eur, 'blocked_minutes', m.blocked_minutes,
        'tokens_in', m.tokens_in, 'tokens_out', m.tokens_out, 'tokens_cache', m.tokens_cache,
        'sessions', m.sessions, 'events', m.events) order by m.hour)
      from (select * from staff.metrics_hourly where hour > now() - interval '8 days') m), '[]'::jsonb),
    'readiness', coalesce((select jsonb_agg(jsonb_build_object(
        'key', r.key, 'label', r.label, 'weight', r.weight, 'score', r.score,
        'evidence_url', r.evidence_url, 'evidence_note', r.evidence_note, 'updated_at', r.updated_at)
        order by r.weight desc) from staff.readiness r), '[]'::jsonb),
    'readiness_score', (select round(sum(weight * score) / 5 * 100, 1) from staff.readiness),
    'settings', coalesce((select jsonb_object_agg(key, value) from staff.settings), '{}'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'label', d.label, 'status', d.status, 'created_at', d.created_at,
        'trusted_at', d.trusted_at, 'last_seen_at', d.last_seen_at)
        order by d.created_at desc) from staff.devices d where d.user_id = uid), '[]'::jsonb),
    'instructions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'target', x.target, 'body', x.body, 'status', x.status,
        'created_at', x.created_at, 'result', x.result) order by x.created_at desc)
      from (select * from staff.instructions order by created_at desc limit 20) x), '[]'::jsonb),
    -- neu in Stufe 2
    'blackboard', (select jsonb_build_object('body', b.body, 'updated_by', b.updated_by,
                                             'updated_at', b.updated_at)
                     from staff.blackboard b where b.id = 1),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'ts', m.ts, 'from_agent', m.from_agent, 'to_agent', m.to_agent,
        'body', m.body, 'delivered_at', m.delivered_at) order by m.ts desc)
      from (select * from staff.messages order by ts desc limit 30) m), '[]'::jsonb),
    'service_usage', coalesce((select jsonb_agg(jsonb_build_object(
        'service', s.service, 'metric', s.metric, 'value', s.value,
        'detail', s.detail, 'ts', s.ts))
      from (select distinct on (service, metric) * from staff.service_usage
             order by service, metric, ts desc) s), '[]'::jsonb),
    'voice', coalesce((select jsonb_agg(jsonb_build_object(
        'id', v.id, 'created_at', v.created_at, 'status', v.status,
        'transcript', v.transcript, 'duration_ms', v.duration_ms) order by v.created_at desc)
      from (select * from staff.voice_notes order by created_at desc limit 8) v), '[]'::jsonb),
    'digest', (select jsonb_build_object(
        'since', mem.last_seen_at,
        'cards_done', (select count(*) from staff.tasks
                        where status = 'done' and finished_at > coalesce(mem.last_seen_at, now() - interval '24 hours')),
        'events', (select count(*) from staff.events
                    where ts > coalesce(mem.last_seen_at, now() - interval '24 hours')),
        'open_approvals', (select count(*) from staff.approvals where status = 'open'),
        'incidents', (select count(*) from staff.incidents
                       where ts > coalesce(mem.last_seen_at, now() - interval '24 hours')))
      from staff.members mem where mem.user_id = uid)
  ) into res;
  update staff.devices set last_seen_at = now()
   where user_id = uid and status = 'trusted'
     and token_hash = encode(extensions.digest(staff.device_token(), 'sha256'), 'hex');
  return res;
end $$;

-- Besuch quittieren: setzt last_seen_at und liefert den Digest des Besuchs davor.
create or replace function staff.visit() returns jsonb
language plpgsql security definer set search_path = staff, public as $$
declare prev timestamptz; uid uuid := auth.uid(); out jsonb;
begin
  if not staff.device_ok() then
    return jsonb_build_object('ok', false, 'reason', 'device_not_trusted');
  end if;
  select last_seen_at into prev from staff.members where user_id = uid;
  update staff.members set last_seen_at = now() where user_id = uid;
  select jsonb_build_object(
    'ok', true,
    'since', prev,
    'cards_done', (select count(*) from staff.tasks
                    where status = 'done' and finished_at > coalesce(prev, now() - interval '24 hours')),
    'events', (select count(*) from staff.events
                where ts > coalesce(prev, now() - interval '24 hours')),
    'open_approvals', (select count(*) from staff.approvals where status = 'open'),
    'incidents', (select count(*) from staff.incidents
                   where ts > coalesce(prev, now() - interval '24 hours')),
    'tokens', (select coalesce(sum(tokens),0) from staff.metrics_hourly
                where hour > coalesce(prev, now() - interval '24 hours'))
  ) into out;
  return out;
end $$;

create or replace function staff.set_blackboard(p_body text) returns jsonb
language plpgsql security definer set search_path = staff, public as $$
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  if length(btrim(coalesce(p_body,''))) < 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_short');
  end if;
  if length(p_body) > 900 then
    return jsonb_build_object('ok', false, 'reason', 'too_long', 'max', 900);
  end if;
  insert into staff.blackboard(id, body, updated_by, updated_at)
    values (1, btrim(p_body), 'jan', now())
    on conflict (id) do update set body = excluded.body, updated_by = 'jan', updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Sprachbefehl hochladen (Audio als base64, max ~2 MB dekodiert).
create or replace function staff.submit_voice(p_audio text, p_mime text, p_duration_ms int)
returns jsonb language plpgsql security definer set search_path = staff, public as $$
declare new_id uuid;
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  if length(coalesce(p_audio,'')) < 100 then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if length(p_audio) > 3000000 then
    return jsonb_build_object('ok', false, 'reason', 'too_large', 'max_mb', 2);
  end if;
  insert into staff.voice_notes(mime, duration_ms, audio, status)
    values (left(coalesce(p_mime,'audio/webm'),80), p_duration_ms, p_audio, 'queued')
    returning id into new_id;
  insert into staff.events(agent_key, kind, message)
    values ('jarvis', 'voice', 'Sprachnachricht eingegangen (' ||
            coalesce(round(p_duration_ms/1000.0)::text || ' s', 'unbekannt') || ')');
  return jsonb_build_object('ok', true, 'id', new_id);
end $$;

-- Nachricht an einen Agenten (auch aus der Oberfläche).
create or replace function staff.send_message(p_from text, p_to text, p_body text)
returns jsonb language plpgsql security definer set search_path = staff, public as $$
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  if not exists (select 1 from staff.agents where key = p_to) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_agent');
  end if;
  if length(btrim(coalesce(p_body,''))) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'too_short');
  end if;
  insert into staff.messages(from_agent, to_agent, body)
    values (coalesce(p_from,'jan'), p_to, btrim(p_body));
  return jsonb_build_object('ok', true);
end $$;

grant execute on function staff.visit(), staff.set_blackboard(text),
  staff.submit_voice(text,text,int), staff.send_message(text,text,text) to authenticated;

-- ---------------------------------------------------------------- Startinhalte

insert into staff.blackboard(id, body, updated_by, updated_at) values (1,
 'Staff Board steht. Agenten arbeiten über Kanban, Freigaben laufen über das Board, der Watchdog prüft jede Minute. Offen: vier Cron-Zustellungen und 14 GB freier Speicher.',
 'jarvis', now())
on conflict (id) do nothing;

insert into staff.settings(key, value) values
 ('briefing_url', '{"url": "http://192.168.178.119:8000/briefing"}'::jsonb),
 ('antigravity', '{"log_dir": "~/.gemini/antigravity-cli/log", "check_hour": 7}'::jsonb)
on conflict (key) do nothing;

insert into staff.events(agent_key, kind, message)
  values ('jarvis','system','Ausbaustufe 2 aktiv: Analytik, Folgearbeit, Sprachbefehl, Tafel, Agentenkontakt.');

-- JARVIS OS — Staff Board v2 · Schema, Sicherheit, Seed
-- Projekt: jarvis-os (eggrvcohkaizbcsxtywi), eu-central-1
--
-- Sicherheitsmodell (Kurzfassung):
--   * Ein Mensch (role=owner, genau einer) und ein Dienst (role=agent, der Daemon).
--   * Jede Lese-/Schreiboperation der Weboberflaeche verlangt ein GERAETE-TOKEN, das nur
--     nach bestandener Sicherheitsfrage in der DB als "trusted" markiert wurde.
--     Das Token wandert im Header x-device-token; die Pruefung passiert in Postgres (RLS),
--     nicht im Browser.
--   * Der Daemon laeuft als eigener Auth-User (role=agent) und darf nur schreiben, nie
--     ueber Freigaben entscheiden.
--   * Kein service_role-Key im Browser, keiner im Daemon.

create schema if not exists staff;
revoke all on schema staff from public;
grant usage on schema staff to anon, authenticated;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- Stammdaten

create table if not exists staff.members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text,
  role         text not null default 'owner' check (role in ('owner','agent')),
  display_name text,
  created_at   timestamptz not null default now()
);

-- Einmal-Code, mit dem der erste Mensch Eigentuemer wird (gehasht, einmal verwendbar).
create table if not exists staff.bootstrap (
  id         int primary key default 1 check (id = 1),
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists staff.devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  label        text,
  user_agent   text,
  token_hash   text not null unique,
  status       text not null default 'pending' check (status in ('pending','trusted','revoked')),
  created_at   timestamptz not null default now(),
  trusted_at   timestamptz,
  last_seen_at timestamptz
);
create index if not exists devices_user_idx on staff.devices(user_id);

create table if not exists staff.security_questions (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  question    text not null,
  answer_hash text not null,
  attempts    int not null default 0,
  locked_until timestamptz,
  updated_at  timestamptz not null default now()
);

create table if not exists staff.agents (
  key          text primary key,
  name         text not null,
  role         text not null,
  level        int  not null default 3,          -- 1 Inhaber, 2 COO, 3 Bereichsleiter, 4 Worker
  personality  text,
  mandate      text,
  limits       text,
  model        text,
  budget_eur_day numeric(6,2) default 3.00,
  reports_to   text references staff.agents(key),
  active       boolean not null default true,
  sort         int default 100,
  updated_at   timestamptz default now()
);

-- ---------------------------------------------------------------- Betriebsdaten

create table if not exists staff.tasks (
  id           uuid primary key default gen_random_uuid(),
  agent_key    text references staff.agents(key) on delete set null,
  title        text not null,
  detail       text,
  status       text not null default 'todo'
               check (status in ('todo','scheduled','running','blocked','review','done')),
  progress     int default 0 check (progress between 0 and 100),
  current_step text,
  kanban_id    text,
  priority     int default 2,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists tasks_status_idx on staff.tasks(status);
create index if not exists tasks_agent_idx  on staff.tasks(agent_key);

create table if not exists staff.heartbeats (
  agent_key       text primary key references staff.agents(key) on delete cascade,
  last_seen       timestamptz not null default now(),
  status          text not null default 'idle' check (status in ('idle','running','waiting','error')),
  tokens_today    bigint default 0,
  cost_eur_today  numeric(8,3) default 0,
  meta            jsonb default '{}'::jsonb
);

create table if not exists staff.events (
  id        bigserial primary key,
  ts        timestamptz not null default now(),
  agent_key text,
  kind      text not null,
  message   text not null,
  payload   jsonb default '{}'::jsonb
);
create index if not exists events_ts_idx on staff.events(ts desc);

create table if not exists staff.approvals (
  id             uuid primary key default gen_random_uuid(),
  requested_by   text references staff.agents(key) on delete set null,
  kind           text not null default 'other'
                 check (kind in ('subagents','deploy','purchase','delete','external','other')),
  title          text not null,
  question       text,
  recommendation text,
  cost_tokens    bigint,
  cost_eur       numeric(8,2),
  risk           text default 'low' check (risk in ('low','medium','high')),
  status         text not null default 'open'
                 check (status in ('open','approved','denied','expired','withdrawn')),
  default_decision text not null default 'deny' check (default_decision in ('approve','deny')),
  expires_at     timestamptz,
  decided_at     timestamptz,
  decided_by     uuid,
  decision_note  text,
  applied_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists approvals_status_idx on staff.approvals(status, created_at desc);

create table if not exists staff.instructions (
  id         uuid primary key default gen_random_uuid(),
  target     text references staff.agents(key) on delete cascade,
  body       text not null,
  status     text not null default 'queued' check (status in ('queued','taken','done','failed')),
  created_at timestamptz not null default now(),
  taken_at   timestamptz,
  result     text
);
create index if not exists instructions_status_idx on staff.instructions(status, created_at);

create table if not exists staff.incidents (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  severity     text not null check (severity in ('info','warn','critical')),
  source       text not null,
  summary      text not null,
  action_taken text,
  needs_jan    boolean default false,
  resolved_at  timestamptz
);
create index if not exists incidents_ts_idx on staff.incidents(ts desc);

create table if not exists staff.watchdog_checks (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  check_key  text not null,
  status     text not null check (status in ('ok','warn','fail')),
  detail     text,
  latency_ms int
);
create index if not exists watchdog_ts_idx on staff.watchdog_checks(ts desc);

create table if not exists staff.metrics_hourly (
  hour            timestamptz not null,
  agent_key       text not null,
  tasks_done      int default 0,
  tokens          bigint default 0,
  cost_eur        numeric(8,3) default 0,
  blocked_minutes int default 0,
  primary key (hour, agent_key)
);

create table if not exists staff.readiness (
  key           text primary key,
  label         text not null,
  weight        numeric(4,3) not null,
  score         int not null check (score between 0 and 5),
  evidence_url  text,
  evidence_note text,
  updated_at    timestamptz not null default now()
);

create table if not exists staff.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- Helfer

create or replace function staff.my_role() returns text
language sql stable security definer set search_path = staff, public as $$
  select role from staff.members where user_id = auth.uid();
$$;

create or replace function staff.is_owner() returns boolean
language sql stable security definer set search_path = staff, public as $$
  select coalesce(staff.my_role() = 'owner', false);
$$;

create or replace function staff.is_agent() returns boolean
language sql stable security definer set search_path = staff, public as $$
  select coalesce(staff.my_role() = 'agent', false);
$$;

-- Rohwert des Geraetetokens aus dem Request-Header (leer, wenn nicht gesetzt).
create or replace function staff.device_token() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-device-token', '');
$$;

-- Ist das anfragende Geraet fuer den eingeloggten Menschen freigeschaltet?
create or replace function staff.device_ok() returns boolean
language sql stable security definer set search_path = staff, public, extensions as $$
  select exists (
    select 1 from staff.devices d
     where d.user_id = auth.uid()
       and d.status = 'trusted'
       and d.token_hash = encode(digest(staff.device_token(), 'sha256'), 'hex')
  );
$$;

-- Oberflaeche: Mensch + freigeschaltetes Geraet.
create or replace function staff.ui_ok() returns boolean
language sql stable security definer set search_path = staff, public as $$
  select staff.is_owner() and staff.device_ok();
$$;

create or replace function staff.read_ok() returns boolean
language sql stable security definer set search_path = staff, public as $$
  select staff.ui_ok() or staff.is_agent();
$$;

grant execute on function staff.my_role(), staff.is_owner(), staff.is_agent(),
  staff.device_token(), staff.device_ok(), staff.ui_ok(), staff.read_ok() to anon, authenticated;

-- ---------------------------------------------------------------- RPCs

-- Einmalige Uebernahme des Eigentuemers. Nur solange noch keiner existiert.
create or replace function staff.claim_owner(p_code text) returns jsonb
language plpgsql security definer set search_path = staff, public, extensions as $$
declare b staff.bootstrap; uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  if exists (select 1 from staff.members where role = 'owner') then
    return jsonb_build_object('ok', false, 'reason', 'already_claimed');
  end if;
  select * into b from staff.bootstrap where id = 1;
  if b.code_hash is null or b.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'code_invalid');
  end if;
  if encode(digest(coalesce(p_code,''), 'sha256'), 'hex') <> b.code_hash then
    return jsonb_build_object('ok', false, 'reason', 'code_invalid');
  end if;
  insert into staff.members(user_id, email, role, display_name)
    values (uid, (select email from auth.users where id = uid), 'owner', 'Jan')
    on conflict (user_id) do update set role = 'owner';
  update staff.bootstrap set used_at = now() where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- Sicherheitsfrage setzen/ändern (Antwort wird mit bcrypt gehasht, nie im Klartext).
create or replace function staff.set_security_question(p_question text, p_answer text) returns jsonb
language plpgsql security definer set search_path = staff, public, extensions as $$
begin
  if not staff.is_owner() then return jsonb_build_object('ok', false, 'reason', 'not_owner'); end if;
  if length(btrim(coalesce(p_question,''))) < 6 or length(btrim(coalesce(p_answer,''))) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'too_short');
  end if;
  insert into staff.security_questions(user_id, question, answer_hash, attempts, locked_until, updated_at)
    values (auth.uid(), btrim(p_question), crypt(lower(btrim(p_answer)), gen_salt('bf')), 0, null, now())
    on conflict (user_id) do update
      set question = excluded.question,
          answer_hash = excluded.answer_hash,
          attempts = 0,
          locked_until = null,
          updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Statusabfrage fuer die Oberflaeche: darf dieses Geraet Daten sehen?
create or replace function staff.device_status() returns jsonb
language plpgsql stable security definer set search_path = staff, public as $$
begin
  return jsonb_build_object(
    'authenticated', auth.uid() is not null,
    'member', staff.is_owner() or staff.is_agent(),
    'role', staff.my_role(),
    'trusted', staff.device_ok(),
    'has_question', exists (select 1 from staff.security_questions where user_id = auth.uid()),
    'owner_claimed', exists (select 1 from staff.members where role = 'owner')
  );
end $$;

-- Neues Geraet anmelden: legt es "pending" an und liefert die Sicherheitsfrage.
create or replace function staff.register_device(p_label text, p_ua text, p_token text) returns jsonb
language plpgsql security definer set search_path = staff, public, extensions as $$
declare d staff.devices; q text;
begin
  if not staff.is_owner() then return jsonb_build_object('ok', false, 'reason', 'not_owner'); end if;
  if length(coalesce(p_token,'')) < 32 then
    return jsonb_build_object('ok', false, 'reason', 'weak_token');
  end if;
  select question into q from staff.security_questions where user_id = auth.uid();
  insert into staff.devices(user_id, label, user_agent, token_hash, status)
    values (auth.uid(), left(coalesce(p_label,'Gerät'),60), left(coalesce(p_ua,''),200),
            encode(digest(p_token,'sha256'),'hex'), 'pending')
    returning * into d;
  return jsonb_build_object('ok', true, 'device_id', d.id, 'question', q,
                            'needs_question', q is null);
end $$;

-- Sicherheitsfrage beantworten -> Geraet wird freigeschaltet (3 Versuche, dann 15 min Sperre).
create or replace function staff.answer_device(p_device uuid, p_answer text) returns jsonb
language plpgsql security definer set search_path = staff, public, extensions as $$
declare s staff.security_questions; d staff.devices;
begin
  if not staff.is_owner() then return jsonb_build_object('ok', false, 'reason', 'not_owner'); end if;
  select * into d from staff.devices where id = p_device and user_id = auth.uid();
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'device_unknown'); end if;
  select * into s from staff.security_questions where user_id = auth.uid();
  if s.user_id is null then return jsonb_build_object('ok', false, 'reason', 'no_question'); end if;
  if s.locked_until is not null and s.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'until', s.locked_until);
  end if;
  if crypt(lower(btrim(coalesce(p_answer,''))), s.answer_hash) = s.answer_hash then
    update staff.devices set status='trusted', trusted_at=now(), last_seen_at=now() where id = d.id;
    update staff.security_questions set attempts=0, locked_until=null where user_id = auth.uid();
    insert into staff.events(agent_key, kind, message)
      values ('jarvis', 'security', 'Neues Gerät freigeschaltet: ' || coalesce(d.label,'Gerät'));
    return jsonb_build_object('ok', true);
  end if;
  if s.attempts + 1 >= 3 then
    update staff.security_questions set attempts = 0, locked_until = now() + interval '15 minutes'
      where user_id = auth.uid();
    insert into staff.incidents(severity, source, summary, needs_jan)
      values ('warn','auth','Drei falsche Antworten auf die Sicherheitsfrage — 15 Minuten gesperrt', false);
    return jsonb_build_object('ok', false, 'reason', 'locked', 'until', now() + interval '15 minutes');
  end if;
  update staff.security_questions set attempts = s.attempts + 1 where user_id = auth.uid();
  return jsonb_build_object('ok', false, 'reason', 'wrong', 'attempts_left', 2 - s.attempts);
end $$;

create or replace function staff.revoke_device(p_device uuid) returns jsonb
language plpgsql security definer set search_path = staff, public as $$
begin
  if not staff.ui_ok() then return jsonb_build_object('ok', false, 'reason', 'not_trusted'); end if;
  update staff.devices set status='revoked' where id = p_device and user_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- Daemon: abgelaufene Freigaben nach Standard-Entscheidung abschliessen.
create or replace function staff.expire_approvals() returns int
language plpgsql security definer set search_path = staff, public as $$
declare n int;
begin
  if not staff.is_agent() then return 0; end if;
  with upd as (
    update staff.approvals
       set status = case when default_decision = 'approve' then 'approved' else 'denied' end,
           decided_at = now(),
           decision_note = 'automatisch nach Frist (Standard-Entscheidung)'
     where status = 'open' and expires_at is not null and expires_at < now()
    returning 1
  ) select count(*) into n from upd;
  return n;
end $$;

-- Daemon: Freigabe als ausgefuehrt markieren (nur setzen, nie entscheiden).
create or replace function staff.mark_approval_applied(p_id uuid) returns jsonb
language plpgsql security definer set search_path = staff, public as $$
begin
  if not staff.is_agent() then return jsonb_build_object('ok', false, 'reason', 'not_agent'); end if;
  update staff.approvals set applied_at = now()
   where id = p_id and status in ('approved','denied') and applied_at is null;
  return jsonb_build_object('ok', true);
end $$;

grant execute on function staff.claim_owner(text), staff.set_security_question(text,text),
  staff.device_status(), staff.register_device(text,text,text), staff.answer_device(uuid,text),
  staff.revoke_device(uuid), staff.expire_approvals(), staff.mark_approval_applied(uuid)
  to authenticated;

-- ---------------------------------------------------------------- RLS

alter table staff.members            enable row level security;
alter table staff.bootstrap          enable row level security;
alter table staff.devices            enable row level security;
alter table staff.security_questions enable row level security;
alter table staff.agents             enable row level security;
alter table staff.tasks              enable row level security;
alter table staff.heartbeats         enable row level security;
alter table staff.events             enable row level security;
alter table staff.approvals          enable row level security;
alter table staff.instructions       enable row level security;
alter table staff.incidents          enable row level security;
alter table staff.watchdog_checks    enable row level security;
alter table staff.metrics_hourly     enable row level security;
alter table staff.readiness          enable row level security;
alter table staff.settings           enable row level security;

-- keine Policies fuer anon: ohne Login ist alles dicht.
revoke all on all tables in schema staff from anon;

grant select, insert, update, delete on all tables in schema staff to authenticated;
grant usage, select on all sequences in schema staff to authenticated;

drop policy if exists members_self on staff.members;
create policy members_self on staff.members for select to authenticated
  using (user_id = auth.uid());

drop policy if exists devices_own on staff.devices;
create policy devices_own on staff.devices for select to authenticated
  using (user_id = auth.uid() and staff.is_owner());

drop policy if exists agents_read on staff.agents;
create policy agents_read on staff.agents for select to authenticated using (staff.read_ok());
drop policy if exists agents_write on staff.agents;
create policy agents_write on staff.agents for all to authenticated
  using (staff.ui_ok() or staff.is_agent()) with check (staff.ui_ok() or staff.is_agent());

drop policy if exists tasks_read on staff.tasks;
create policy tasks_read on staff.tasks for select to authenticated using (staff.read_ok());
drop policy if exists tasks_write on staff.tasks;
create policy tasks_write on staff.tasks for all to authenticated
  using (staff.ui_ok() or staff.is_agent()) with check (staff.ui_ok() or staff.is_agent());

drop policy if exists hb_read on staff.heartbeats;
create policy hb_read on staff.heartbeats for select to authenticated using (staff.read_ok());
drop policy if exists hb_write on staff.heartbeats;
create policy hb_write on staff.heartbeats for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());

drop policy if exists events_read on staff.events;
create policy events_read on staff.events for select to authenticated using (staff.read_ok());
drop policy if exists events_write on staff.events;
create policy events_write on staff.events for insert to authenticated
  with check (staff.ui_ok() or staff.is_agent());

drop policy if exists approvals_read on staff.approvals;
create policy approvals_read on staff.approvals for select to authenticated using (staff.read_ok());
drop policy if exists approvals_insert on staff.approvals;
create policy approvals_insert on staff.approvals for insert to authenticated
  with check (staff.ui_ok() or staff.is_agent());
-- entscheiden darf ausschliesslich der Mensch auf einem freigeschalteten Geraet
drop policy if exists approvals_decide on staff.approvals;
create policy approvals_decide on staff.approvals for update to authenticated
  using (staff.ui_ok()) with check (staff.ui_ok());

drop policy if exists instr_read on staff.instructions;
create policy instr_read on staff.instructions for select to authenticated using (staff.read_ok());
drop policy if exists instr_insert on staff.instructions;
create policy instr_insert on staff.instructions for insert to authenticated with check (staff.ui_ok());
drop policy if exists instr_update on staff.instructions;
create policy instr_update on staff.instructions for update to authenticated
  using (staff.is_agent() or staff.ui_ok()) with check (staff.is_agent() or staff.ui_ok());

drop policy if exists incidents_read on staff.incidents;
create policy incidents_read on staff.incidents for select to authenticated using (staff.read_ok());
drop policy if exists incidents_write on staff.incidents;
create policy incidents_write on staff.incidents for all to authenticated
  using (staff.is_agent() or staff.ui_ok()) with check (staff.is_agent() or staff.ui_ok());

drop policy if exists wd_read on staff.watchdog_checks;
create policy wd_read on staff.watchdog_checks for select to authenticated using (staff.read_ok());
drop policy if exists wd_write on staff.watchdog_checks;
create policy wd_write on staff.watchdog_checks for insert to authenticated with check (staff.is_agent());

drop policy if exists metrics_read on staff.metrics_hourly;
create policy metrics_read on staff.metrics_hourly for select to authenticated using (staff.read_ok());
drop policy if exists metrics_write on staff.metrics_hourly;
create policy metrics_write on staff.metrics_hourly for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());

drop policy if exists readiness_read on staff.readiness;
create policy readiness_read on staff.readiness for select to authenticated using (staff.read_ok());
drop policy if exists readiness_write on staff.readiness;
create policy readiness_write on staff.readiness for all to authenticated
  using (staff.ui_ok() or staff.is_agent()) with check (staff.ui_ok() or staff.is_agent());

drop policy if exists settings_read on staff.settings;
create policy settings_read on staff.settings for select to authenticated using (staff.read_ok());
drop policy if exists settings_write on staff.settings;
create policy settings_write on staff.settings for all to authenticated
  using (staff.ui_ok() or staff.is_agent()) with check (staff.ui_ok() or staff.is_agent());

-- ---------------------------------------------------------------- Realtime

do $$
begin
  begin
    alter publication supabase_realtime add table staff.tasks;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table staff.approvals;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table staff.events;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table staff.heartbeats;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table staff.instructions;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table staff.incidents;
  exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------- Seed

insert into staff.bootstrap(id, code_hash) values (1, '7c7e0ae724b333d31a21864581c1892fa87ca3d56536ad29b4cdae4d3e787463')
  on conflict (id) do nothing;

insert into staff.members(user_id, email, role, display_name)
  values ('2990efd2-5af8-4e21-9393-74397f4b19fe', 'agent@jarvis-os.local', 'agent', 'staffd')
  on conflict (user_id) do update set role = 'agent';

insert into staff.agents(key, name, role, level, personality, mandate, limits, model, budget_eur_day, reports_to, sort) values
 ('jarvis','JARVIS','COO',2,
  'Trocken, direkt, kein Lob ohne Deckung. Denkt in Risiken und Fristen.',
  'Zerlegt Aufträge in Karten, verteilt sie an die Bereichsleiter, berichtet und eskaliert nur das, was Jan wirklich braucht.',
  'Entscheidet reversible Schritte selbst bis 3 €/Tag. Kauft, löscht, veröffentlicht und verschickt nichts ohne Freigabe.',
  'deepseek-v4.1-flash', 12.00, null, 10),
 ('peter','peter','CTO Produkt & Web',3,
  'Ungeduldig, will live gehen. „Wenn es nicht live ist, ist es nicht fertig.“',
  'Verantwortet savood.site, Supabase-Anbindung und Frontend. Liefert lauffähige Deploys statt Konzepte.',
  'Kein Deploy auf die öffentliche Domain ohne Freigabe. Kein Schema-Change auf Produktionsdaten.',
  'deepseek-v4.1-flash', 3.00, 'jarvis', 20),
 ('david','david','Hardware & Firmware',3,
  'Ruhig, misst alles. „Messen, nicht raten.“',
  'ESP32-P4-Firmware, Display, OTA und Sensorik. Dokumentiert jeden Flash mit Messwerten.',
  'Flasht nur an Geräten, die ihm zugewiesen sind. Keine OTA-Auslieferung ohne Freigabe.',
  'deepseek-v4.1-flash', 3.00, 'jarvis', 30),
 ('frank','frank','Produktion & 3D',3,
  'Pragmatisch. „Druckbar schlägt schön.“',
  'Bambu-Drucke, MakerWorld-Produkte, Fertigung und Materialwirtschaft.',
  'Keine Käufe (Filament, Modelle) ohne Freigabe. Keine Drucke über 4 h ohne Ankündigung.',
  'deepseek-v4.1-flash', 2.00, 'jarvis', 40),
 ('luca','luca','Ops & Recherche',3,
  'Skeptisch gegenüber jeder Zahl ohne Quelle. „Eine Zahl ohne Quelle ist eine Meinung.“',
  'Datenarbeit, Scraping, Studiensuche, Berichte. Liefert Ergebnisse mit Quellenangabe.',
  'Keine Konten anlegen, keine Formulare absenden, keine Mails nach außen.',
  'deepseek-v4.1-flash', 3.00, 'jarvis', 50),
 ('charlie','charlie','Qualität & Feuerwehr',3,
  'Hartnäckig, unbequem. „Ich will die Ursache, nicht das Symptom.“',
  'Wird gerufen, wenn etwas hängt oder unklar ist. Sucht Ursachen, prüft Ergebnisse anderer adversarial.',
  'Darf fremde Arbeit verwerfen, aber nicht ohne Begründung. Entscheidet keine Freigaben.',
  'deepseek-v4.1-flash', 3.00, 'jarvis', 60)
on conflict (key) do update set
  name = excluded.name, role = excluded.role, level = excluded.level,
  personality = excluded.personality, mandate = excluded.mandate, limits = excluded.limits,
  budget_eur_day = excluded.budget_eur_day, reports_to = excluded.reports_to, sort = excluded.sort;

insert into staff.heartbeats(agent_key, status) select key, 'idle' from staff.agents
on conflict (agent_key) do nothing;

insert into staff.readiness(key, label, weight, score, evidence_note) values
 ('produkt','Produkt funktioniert im Feld',0.250,3,'Display läuft im Testhaushalt, Kamera und OTA noch nicht stabil.'),
 ('stabilitaet','Stabilität & Betrieb',0.150,2,'Hub fiel heute 5 Minuten aus, zwei Berichte nicht zugestellt.'),
 ('nutzer','Echte Nutzer',0.150,1,'Ein Testhaushalt, keine zahlenden Nutzer.'),
 ('preis','Preis & Zahlungsbereitschaft',0.100,2,'Preisidee vorhanden, keine Zahlung getestet.'),
 ('recht','Recht & Zertifikate',0.100,1,'Keine CE-Prüfung, kein Datenschutzkonzept für Kundendaten.'),
 ('vertrieb','Vertrieb & Reichweite',0.100,1,'Kein Shop, keine Liste, keine Kampagne.'),
 ('support','Support & Doku',0.050,2,'Interne Doku vorhanden, keine Nutzerdoku.'),
 ('skalierung','Skalierung & Herstellung',0.100,2,'Einzelfertigung, keine Stückkostenkalkulation.')
on conflict (key) do update set
  label = excluded.label, weight = excluded.weight, score = excluded.score, evidence_note = excluded.evidence_note;

insert into staff.settings(key, value) values
 ('night_policy', '{"auto_decision_after_hours": 6, "only_reversible": true, "notify_immediately": true}'::jsonb),
 ('budgets', '{"total_eur_day": 12, "per_agent_eur_day": 3, "stop_on_exceed": true}'::jsonb),
 ('watchdog', '{"hub_timeout_s": 2, "provider_probe_interval_s": 60, "task_stall_minutes": 15, "disk_warn_percent": 10}'::jsonb)
on conflict (key) do nothing;

insert into staff.events(agent_key, kind, message)
  values ('jarvis','system','Staff Board v2 in Betrieb genommen. Schema, RLS und Geräteprüfung aktiv.');

-- 003 — Podcast auf Knopfdruck
--
-- Ein Job pro Anfrage. Die Oberflaeche legt ihn an (RPC, Geraetetoken), der Daemon
-- startet den Arbeiter, der Arbeiter schreibt den Fortschritt zurueck. Der Fortschritt
-- ist die einzige Quelle fuer den Balken im Board — keine geschaetzten Zahlen.
--
-- Rate Limit: 30 Minuten zwischen zwei Anfragen. Grund: Gemini-TTS im Free-Tier hat ein
-- hartes Tageslimit (10 Requests). Zwei versehentliche Klicks duerfen das nicht auffressen.

create table if not exists staff.podcast_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued'
    check (status in ('queued','running','done','failed')),
  stage text not null default 'queued',
  progress int not null default 5 check (progress between 0 and 100),
  title text,
  episode_key text,
  audio_url text,
  script_path text,
  error text,
  requested_by text not null default 'jan',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  published_at timestamptz
);

create index if not exists podcast_jobs_recent on staff.podcast_jobs (created_at desc);

alter table staff.podcast_jobs enable row level security;

drop policy if exists daemon_podcast on staff.podcast_jobs;
create policy daemon_podcast on staff.podcast_jobs for all to authenticated
  using (staff.is_agent()) with check (staff.is_agent());

-- Menschen lesen und schreiben ausschliesslich ueber diese Funktionen.
create or replace function staff.podcast_state()
returns jsonb language plpgsql security definer set search_path = staff, public as $$
declare j staff.podcast_jobs;
        last_at timestamptz;
        next_at timestamptz;
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;
  select * into j from staff.podcast_jobs order by created_at desc limit 1;
  select max(created_at) into last_at from staff.podcast_jobs where status in ('queued','running','done');
  next_at := last_at + interval '30 minutes';
  return jsonb_build_object(
    'ok', true,
    'job', case when j.id is null then null else jsonb_build_object(
      'id', j.id, 'status', j.status, 'stage', j.stage, 'progress', j.progress,
      'title', j.title, 'audio_url', j.audio_url, 'error', j.error,
      'created_at', j.created_at, 'published_at', j.published_at) end,
    'last_request_at', last_at,
    'next_allowed_at', case when last_at is null then null else next_at end,
    'can_request', (last_at is null or now() >= next_at)
  );
end $$;

create or replace function staff.request_podcast()
returns jsonb language plpgsql security definer set search_path = staff, public as $$
declare last_at timestamptz;
        j staff.podcast_jobs;
begin
  if not staff.device_ok() then return jsonb_build_object('ok', false, 'reason', 'device_not_trusted'); end if;

  select max(created_at) into last_at from staff.podcast_jobs
   where status in ('queued','running','done');
  if last_at is not null and now() < last_at + interval '30 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
      'next_allowed_at', last_at + interval '30 minutes');
  end if;

  if exists (select 1 from staff.podcast_jobs where status in ('queued','running')) then
    return jsonb_build_object('ok', false, 'reason', 'already_running');
  end if;

  insert into staff.podcast_jobs(status, stage, progress, requested_by)
    values ('queued', 'queued', 5, coalesce((select email from staff.members where user_id = auth.uid()), 'jan'))
    returning * into j;

  insert into staff.events(agent_key, kind, message)
    values ('jarvis', 'podcast', 'Podcast angefordert von Jan');

  return jsonb_build_object('ok', true, 'id', j.id);
end $$;

-- Tabellenrechte fuer den Daemon (role=agent laeuft als authenticated, Policy is_agent()).
-- Ohne diese Zeile antwortet PostgREST mit 403, bevor die Policy ueberhaupt greift.
grant select, insert, update on staff.podcast_jobs to authenticated;

grant execute on function staff.podcast_state(), staff.request_podcast() to authenticated;

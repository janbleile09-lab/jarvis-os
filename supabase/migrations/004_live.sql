-- 004 — Live-Sicht auf laufende Arbeit
--
-- Bisher zeigte das Board nur den Kartentitel und den Status. Was ein Arbeiter in diesem
-- Moment tut, war nicht sichtbar — genau das will Jan sehen. Der Daemon liest deshalb den
-- letzten Eintrag aus der Sitzung des Arbeiters (state.db, Tabelle messages) und legt ihn
-- hier ab. Zusaetzlich die Zahl der Unteragenten, die dieser Arbeiter gestartet hat.

alter table staff.tasks add column if not exists live_note text;
alter table staff.tasks add column if not exists live_at timestamptz;
alter table staff.tasks add column if not exists run_id int;
alter table staff.tasks add column if not exists session_id text;
alter table staff.tasks add column if not exists subagents int not null default 0;

create index if not exists tasks_live on staff.tasks (status) where live_at is not null;

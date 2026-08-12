alter table public.ai_artifacts
  drop constraint if exists ai_artifacts_task_type_check;

alter table public.ai_artifacts
  add constraint ai_artifacts_task_type_check
  check (task_type in ('book_overview', 'reading_insight'));

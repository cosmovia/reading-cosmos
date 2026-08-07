begin;

-- Rows created before the gateway had no task taxonomy. Keep them available for
-- audit, but exclude them from managed book-overview quotas and metrics.
update public.ai_generations
set task_type = 'legacy'
where prompt is not null
  and result is not null
  and provider is null
  and attempts is null
  and task_type = 'book_overview';

-- Covers the composite ownership foreign key used by ai_artifacts.
create index if not exists ai_artifacts_book_owner_idx
  on public.ai_artifacts (book_id, user_id);

commit;

begin;

alter table public.user_settings
  add column if not exists ai_note_consent_at timestamptz;

-- Legacy note suggestions must not survive as saved book data. Preserve the
-- independent book overview and any historical automatic summary only.
update public.books
set ai_data =
  (coalesce(ai_data, '{}'::jsonb) - 'summary' - 'concepts' - 'thoughts' - 'actions')
  || case
    when ai_data -> 'summary' ->> 'operation' = 'auto_summary'
      then jsonb_build_object('summary', ai_data -> 'summary')
    else '{}'::jsonb
  end
where coalesce(ai_data, '{}'::jsonb) ?| array['summary', 'concepts', 'thoughts', 'actions'];

commit;

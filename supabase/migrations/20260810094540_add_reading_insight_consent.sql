alter table public.user_settings
  add column if not exists ai_insight_consent_at timestamptz;

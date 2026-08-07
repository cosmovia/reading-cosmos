begin;

-- Required for an ownership-preserving composite foreign key.
alter table public.books
  add constraint books_id_user_id_unique unique (id, user_id);

create table public.ai_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id uuid,
  task_type text not null check (task_type in ('book_overview')),
  scope_key text not null,
  input_hash text not null,
  source_revision bigint not null default 0 check (source_revision >= 0),
  prompt_version text not null,
  content jsonb not null default '{}'::jsonb
    check (jsonb_typeof(content) = 'object'),
  sources jsonb not null default '[]'::jsonb
    check (jsonb_typeof(sources) = 'array'),
  provider text not null,
  model text not null,
  generated_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_artifacts_book_owner_fkey
    foreign key (book_id, user_id)
    references public.books (id, user_id)
    on delete cascade,
  constraint ai_artifacts_cache_key_unique
    unique (user_id, task_type, scope_key, input_hash, prompt_version)
);

create index ai_artifacts_user_task_scope_generated_idx
  on public.ai_artifacts (user_id, task_type, scope_key, generated_at desc);
create index ai_artifacts_book_id_idx
  on public.ai_artifacts (book_id);

create trigger ai_artifacts_set_updated_at
before update on public.ai_artifacts
for each row execute function public.update_updated_at_column();

alter table public.ai_artifacts enable row level security;

revoke all privileges on table public.ai_artifacts from anon, authenticated;
grant select on table public.ai_artifacts to authenticated;

create policy "ai_artifacts_select_own"
on public.ai_artifacts for select to authenticated
using ((select auth.uid()) = user_id);

-- Invocation telemetry deliberately excludes complete prompts, notes, API keys,
-- and raw provider payloads.
alter table public.ai_generations
  add column request_id uuid not null default gen_random_uuid(),
  add column task_type text not null default 'book_overview',
  add column provider text,
  add column status text not null default 'succeeded'
    check (status in ('succeeded', 'failed')),
  add column error_code text,
  add column latency_ms integer check (latency_ms >= 0),
  add column input_tokens integer check (input_tokens >= 0),
  add column output_tokens integer check (output_tokens >= 0),
  add column cost_microusd bigint check (cost_microusd >= 0),
  add column cache_hit boolean not null default false,
  add column fallback_index smallint not null default 0 check (fallback_index >= 0),
  add column prompt_version text,
  add column attempts smallint check (attempts > 0),
  add constraint ai_generations_request_id_unique unique (request_id);

create index ai_generations_user_created_idx
  on public.ai_generations (user_id, created_at desc);
create index ai_generations_user_task_created_idx
  on public.ai_generations (user_id, task_type, created_at desc);

commit;

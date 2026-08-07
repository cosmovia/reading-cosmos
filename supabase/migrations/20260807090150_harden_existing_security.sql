begin;

-- Trigger functions must not inherit a caller-controlled search path or be
-- exposed as RPC endpoints. Auth still invokes handle_new_user via its trigger.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.update_updated_at_column() from public, anon, authenticated;

-- API keys are browser-local in BYOK mode and platform credentials belong in
-- Edge Function secrets, never in a regular user-readable table.
alter table public.user_settings drop column if exists glm_api_key;

-- Foreign-key indexes used by ownership checks, deletes, and future reports.
create index if not exists book_notes_book_id_idx
  on public.book_notes (book_id);
create index if not exists ai_generations_book_id_idx
  on public.ai_generations (book_id);
create index if not exists ai_generations_user_id_idx
  on public.ai_generations (user_id);
create index if not exists reading_reports_user_id_idx
  on public.reading_reports (user_id);

-- Remove legacy broad table privileges before granting the minimum used by the
-- current client. RLS remains the row-level authorization boundary.
revoke all privileges on table public.profiles from anon, authenticated;
revoke all privileges on table public.books from anon, authenticated;
revoke all privileges on table public.book_notes from anon, authenticated;
revoke all privileges on table public.ai_generations from anon, authenticated;
revoke all privileges on table public.user_settings from anon, authenticated;
revoke all privileges on table public.reading_reports from anon, authenticated;

grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.books to authenticated;
grant select on table public.book_notes to authenticated;
grant select on table public.ai_generations to authenticated;
grant select, insert, update on table public.user_settings to authenticated;
grant select on table public.reading_reports to authenticated;

-- Replace all legacy policies without depending on their historical names.
do $$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'profiles', 'books', 'book_notes', 'ai_generations',
        'user_settings', 'reading_reports'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  end loop;
end;
$$;

create policy "profiles_select_own"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "profiles_update_own"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "books_select_own"
on public.books for select to authenticated
using ((select auth.uid()) = user_id);

create policy "books_insert_own"
on public.books for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "books_update_own"
on public.books for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "books_delete_own"
on public.books for delete to authenticated
using ((select auth.uid()) = user_id);

create policy "book_notes_select_owned_book"
on public.book_notes for select to authenticated
using (
  exists (
    select 1
    from public.books
    where books.id = book_notes.book_id
      and books.user_id = (select auth.uid())
  )
);

create policy "ai_generations_select_own"
on public.ai_generations for select to authenticated
using ((select auth.uid()) = user_id);

create policy "user_settings_select_own"
on public.user_settings for select to authenticated
using ((select auth.uid()) = user_id);

create policy "user_settings_insert_own"
on public.user_settings for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "user_settings_update_own"
on public.user_settings for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "reading_reports_select_own"
on public.reading_reports for select to authenticated
using ((select auth.uid()) = user_id);

commit;

create table if not exists public.book_relationships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_book_id uuid not null,
  target_book_id uuid not null,
  relationship_type text not null default 'resonates',
  strength smallint not null default 1,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint book_relationships_source_owner_fkey
    foreign key (source_book_id, user_id)
    references public.books(id, user_id) on delete cascade,
  constraint book_relationships_target_owner_fkey
    foreign key (target_book_id, user_id)
    references public.books(id, user_id) on delete cascade,
  constraint book_relationships_distinct_books_check
    check (source_book_id <> target_book_id),
  constraint book_relationships_type_check
    check (relationship_type in ('resonates', 'extends', 'contrasts', 'supports')),
  constraint book_relationships_strength_check
    check (strength between 1 and 3),
  constraint book_relationships_unique_pair
    unique (user_id, source_book_id, target_book_id)
);

create index if not exists book_relationships_target_owner_idx
  on public.book_relationships (target_book_id, user_id);

alter table public.book_relationships enable row level security;

grant select, insert, update, delete
  on table public.book_relationships to authenticated;

drop policy if exists book_relationships_select_own on public.book_relationships;
create policy book_relationships_select_own
  on public.book_relationships for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists book_relationships_insert_own on public.book_relationships;
create policy book_relationships_insert_own
  on public.book_relationships for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists book_relationships_update_own on public.book_relationships;
create policy book_relationships_update_own
  on public.book_relationships for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists book_relationships_delete_own on public.book_relationships;
create policy book_relationships_delete_own
  on public.book_relationships for delete
  to authenticated
  using ((select auth.uid()) = user_id);

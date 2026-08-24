alter table public.books
  add column if not exists sync_revision bigint not null default 0;

comment on column public.books.sync_revision is
  'Monotonic client-write revision used to prevent silent cross-device overwrites.';

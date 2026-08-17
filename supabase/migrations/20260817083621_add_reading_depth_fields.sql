alter table public.books
  add column if not exists reading_depth text not null default 'standard',
  add column if not exists importance smallint not null default 1,
  add column if not exists reading_minutes integer not null default 0;

alter table public.books
  drop constraint if exists books_reading_depth_check,
  add constraint books_reading_depth_check
    check (reading_depth in ('standard', 'deep', 'core')),
  drop constraint if exists books_importance_check,
  add constraint books_importance_check
    check (importance between 1 and 3),
  drop constraint if exists books_reading_minutes_check,
  add constraint books_reading_minutes_check
    check (reading_minutes between 0 and 100000);

comment on column public.books.reading_depth is
  'User-selected reading depth: standard, deep, or core.';
comment on column public.books.importance is
  'User-selected personal importance from 1 to 3.';
comment on column public.books.reading_minutes is
  'Approximate reading investment in minutes, entered by the user.';

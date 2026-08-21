alter table public.books
  add column if not exists finished_at date;

comment on column public.books.finished_at is
  'Optional user-confirmed reading completion date used for the reading trajectory.';

create index if not exists book_relationships_source_owner_idx
  on public.book_relationships (source_book_id, user_id);

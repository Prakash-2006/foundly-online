-- Foundly Online: shared reports, matching, accounts, chat, and per-pair phone sharing.
create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create table if not exists public.profiles_public (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 2 and 32),
  created_at timestamptz not null default now()
);

-- Email and phone are kept in a separate table and never included in public report queries.
create table if not exists public.profiles_private (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  phone text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles_private p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;
revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  chosen_name text;
begin
  chosen_name := coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), split_part(coalesce(new.email, 'neighbor'), '@', 1));
  insert into public.profiles_public (id, username)
  values (new.id, left(chosen_name, 32));
  insert into public.profiles_private (id, email, phone, role)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'phone', ''), 'user');
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created_foundly on auth.users;
create trigger on_auth_user_created_foundly
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles_public(id) on delete cascade,
  type text not null check (type in ('lost', 'found')),
  name text not null check (char_length(name) between 1 and 70),
  category text not null check (char_length(category) between 1 and 40),
  color text not null default '' check (char_length(color) <= 40),
  location text not null check (char_length(location) between 1 and 100),
  description text not null default '' check (char_length(description) <= 500),
  image_path text not null,
  report_date date not null check (report_date <= current_date),
  status text not null default 'open' check (status in ('open', 'closed', 'hidden')),
  created_at timestamptz not null default now()
);
create index if not exists reports_open_type_created on public.reports(status, type, created_at desc);
create index if not exists reports_owner_created on public.reports(owner_id, created_at desc);

create table if not exists public.matches (
  lost_report_id uuid not null references public.reports(id) on delete cascade,
  found_report_id uuid not null references public.reports(id) on delete cascade,
  score smallint not null check (score between 0 and 100),
  reasons text[] not null default '{}',
  engine text not null default 'Local match',
  updated_at timestamptz not null default now(),
  primary key (lost_report_id, found_report_id),
  check (lost_report_id <> found_report_id)
);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  lost_report_id uuid not null references public.reports(id) on delete cascade,
  found_report_id uuid not null references public.reports(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (lost_report_id, found_report_id)
);
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid not null references public.profiles_public(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_chat_created on public.messages(chat_id, created_at);

create table if not exists public.phone_shares (
  lost_report_id uuid not null references public.reports(id) on delete cascade,
  found_report_id uuid not null references public.reports(id) on delete cascade,
  shared_by uuid not null references public.profiles_public(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (lost_report_id, found_report_id)
);

alter table public.profiles_public enable row level security;
alter table public.profiles_private enable row level security;
alter table public.reports enable row level security;
alter table public.matches enable row level security;
alter table public.chats enable row level security;
alter table public.messages enable row level security;
alter table public.phone_shares enable row level security;

grant select on public.profiles_public to anon, authenticated;
grant select on public.profiles_private to authenticated;
grant select on public.reports to anon, authenticated;
grant insert, update, delete on public.reports to authenticated;
grant select on public.matches to anon, authenticated;
grant select, insert on public.chats to authenticated;
grant select, insert on public.messages to authenticated;
grant select, insert, delete on public.phone_shares to authenticated;

create policy "Public names are visible" on public.profiles_public
  for select to anon, authenticated using (true);
create policy "People can read their own private profile and admins can review profiles" on public.profiles_private
  for select to authenticated using (id = (select auth.uid()) or (select private.is_admin()));

create policy "Open reports are public; owners and admins can see all their reports" on public.reports
  for select to anon, authenticated
  using (status = 'open' or owner_id = (select auth.uid()) or (select private.is_admin()));
create policy "A person can add their own open report and image" on public.reports
  for insert to authenticated
  with check (
    owner_id = (select auth.uid()) and status = 'open'
    and image_path like ((select auth.uid())::text || '/%')
  );
create policy "Owners or admins can update reports" on public.reports
  for update to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()))
  with check ((owner_id = (select auth.uid()) and image_path like ((select auth.uid())::text || '/%')) or (select private.is_admin()));
create policy "Owners or admins can delete reports" on public.reports
  for delete to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_admin()));

create policy "Open report pairs expose only match suggestions" on public.matches
  for select to anon, authenticated
  using (
    exists (select 1 from public.reports l where l.id = lost_report_id and l.status = 'open')
    and exists (select 1 from public.reports f where f.id = found_report_id and f.status = 'open')
  );

create policy "Report owners can read their chats" on public.chats
  for select to authenticated
  using (
    exists (select 1 from public.reports r where r.id = lost_report_id and r.owner_id = (select auth.uid()))
    or exists (select 1 from public.reports r where r.id = found_report_id and r.owner_id = (select auth.uid()))
  );
create policy "An owner can open a chat for an open lost and found pair" on public.chats
  for insert to authenticated
  with check (
    exists (select 1 from public.reports l where l.id = lost_report_id and l.type = 'lost' and l.status = 'open')
    and exists (select 1 from public.reports f where f.id = found_report_id and f.type = 'found' and f.status = 'open')
    and (
      exists (select 1 from public.reports l where l.id = lost_report_id and l.owner_id = (select auth.uid()))
      or exists (select 1 from public.reports f where f.id = found_report_id and f.owner_id = (select auth.uid()))
    )
  );

create policy "Chat participants can read messages" on public.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.chats c
      where c.id = chat_id and (
        exists (select 1 from public.reports l where l.id = c.lost_report_id and l.owner_id = (select auth.uid()))
        or exists (select 1 from public.reports f where f.id = c.found_report_id and f.owner_id = (select auth.uid()))
      )
    )
  );
create policy "Chat participants can send as themselves" on public.messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid()) and exists (
      select 1 from public.chats c
      where c.id = chat_id and (
        exists (select 1 from public.reports l where l.id = c.lost_report_id and l.owner_id = (select auth.uid()))
        or exists (select 1 from public.reports f where f.id = c.found_report_id and f.owner_id = (select auth.uid()))
      )
    )
  );

create policy "Only either report owner can see a phone share" on public.phone_shares
  for select to authenticated
  using (
    exists (select 1 from public.reports l where l.id = lost_report_id and l.owner_id = (select auth.uid()))
    or exists (select 1 from public.reports f where f.id = found_report_id and f.owner_id = (select auth.uid()))
  );
create policy "Only the finder can share their own number" on public.phone_shares
  for insert to authenticated
  with check (
    shared_by = (select auth.uid())
    and exists (select 1 from public.reports f where f.id = found_report_id and f.type = 'found' and f.owner_id = (select auth.uid()))
    and exists (select 1 from public.reports l where l.id = lost_report_id and l.type = 'lost' and l.owner_id <> (select auth.uid()))
  );
create policy "Only the finder can revoke a phone share" on public.phone_shares
  for delete to authenticated
  using (shared_by = (select auth.uid()) and exists (
    select 1 from public.reports f where f.id = found_report_id and f.owner_id = (select auth.uid())
  ));

-- This RPC returns a finder phone only to the owner of the paired lost report,
-- after that finder explicitly inserted the matching phone_shares row.
create or replace function public.get_shared_found_phone(p_lost_report_id uuid, p_found_report_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pp.phone
  from public.phone_shares ps
  join public.reports l on l.id = ps.lost_report_id
  join public.reports f on f.id = ps.found_report_id
  join public.profiles_private pp on pp.id = f.owner_id
  where ps.lost_report_id = p_lost_report_id
    and ps.found_report_id = p_found_report_id
    and l.owner_id = (select auth.uid())
    and ps.shared_by = f.owner_id;
$$;
revoke all on function public.get_shared_found_phone(uuid, uuid) from public, anon;
grant execute on function public.get_shared_found_phone(uuid, uuid) to authenticated;

-- Listings are public, so the photos in this bucket are public too. Upload and
-- delete operations are still restricted to the owner folder or an admin.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', true, 4194304, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "People can upload photos into their own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'item-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owners or admins can delete listing photos" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'item-photos' and (
      (storage.foldername(name))[1] = (select auth.uid())::text or (select private.is_admin())
    )
  );

-- Realtime keeps separate browsers up to date. Add tables if not already published.
do $$
begin
  alter publication supabase_realtime add table public.reports;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.matches;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.phone_shares;
exception when duplicate_object then null;
end $$;

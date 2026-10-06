-- Вставьте весь этот файл в Supabase -> SQL Editor -> New query -> Run

create table if not exists public.users (
  id uuid primary key,
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key,
  chat_key text not null,
  from_id uuid not null references public.users(id) on delete cascade,
  to_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('text','image')),
  text text not null default '',
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists messages_chat_key_idx on public.messages(chat_key);
create index if not exists messages_created_at_idx on public.messages(created_at);

-- Публичный bucket для фотографий.
insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', true)
on conflict (id) do update set public = true;

-- Важно: сервер использует service_role key и сам контролирует доступ.
-- RLS включаем для таблиц, но не даём публичный доступ.
alter table public.users enable row level security;
alter table public.messages enable row level security;

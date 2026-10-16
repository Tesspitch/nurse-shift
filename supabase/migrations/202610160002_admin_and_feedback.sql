-- Admin console and user feedback. Additive only; existing roster/payroll data is unchanged.

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('admin')),
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_admin_controls (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'blocked')),
  note text check (char_length(note) <= 500),
  updated_at timestamptz not null default now()
);

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null default 'suggestion' check (category in ('suggestion', 'bug', 'question', 'other')),
  message text not null check (char_length(message) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  admin_note text check (char_length(admin_note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feedback_status_created_idx on public.feedback(status, created_at desc);
create index if not exists feedback_user_created_idx on public.feedback(user_id, created_at desc);

alter table public.admin_users enable row level security;
alter table public.user_admin_controls enable row level security;
alter table public.feedback enable row level security;

revoke all on public.admin_users, public.user_admin_controls, public.feedback from anon, authenticated;

create or replace function public.is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where user_id = p_user_id and active
  );
$$;

revoke all on function public.is_admin(uuid) from public, anon, authenticated;
grant execute on function public.is_admin(uuid) to service_role;

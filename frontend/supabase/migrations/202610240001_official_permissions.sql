-- UUID identity and live database assignments are the only authorization source.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create type public.official_role as enum ('district_officer', 'senior_officer', 'system_admin');
create type public.official_district as enum ('Pune', 'Raigad', 'Ratnagiri', 'Satara');
create type public.official_status as enum ('invited', 'active', 'inactive');

create table public.official_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  invitation_email text not null unique,
  status public.official_status not null default 'invited',
  invited_by uuid,
  invited_at timestamptz not null default now(),
  invitation_expires_at timestamptz not null default now() + interval '1 hour',
  accepted_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint active_requires_acceptance check (status <> 'active' or accepted_at is not null)
);

-- Exactly one application role per official. No role is inferred from email or JWT metadata.
create table public.official_role_assignments (
  user_id uuid primary key references public.official_profiles(user_id) on delete cascade,
  role public.official_role not null,
  assigned_by uuid,
  assigned_at timestamptz not null default now()
);
create table public.official_district_assignments (
  user_id uuid not null references public.official_profiles(user_id) on delete cascade,
  district public.official_district not null,
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  primary key (user_id, district)
);
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  target_user_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_at_idx on public.audit_logs(created_at desc);

-- A minimal protected resource contract; no real official records are seeded.
create table public.official_records (
  id uuid primary key default gen_random_uuid(),
  district public.official_district not null,
  title text not null,
  summary text not null default '',
  created_at timestamptz not null default now()
);
create index official_records_district_idx on public.official_records(district);

-- Internal invitation reservation/outbox. Never exposed through client table grants.
create table private.official_invitation_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role public.official_role not null,
  districts public.official_district[] not null,
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  state text not null default 'pending' check (state in ('pending', 'provisioned', 'failed')),
  user_id uuid
);
create unique index one_pending_invitation_email on private.official_invitation_requests(email) where state = 'pending';
alter table private.official_invitation_requests enable row level security;
revoke all on private.official_invitation_requests from public, anon, authenticated, service_role;

-- Internal UUID lookup shared by RLS and server-only provisioning. Not a client RPC.
create function private.official_role_for(p_user_id uuid)
returns public.official_role language sql stable security definer set search_path = '' as $$
  select r.role from public.official_profiles p
  join public.official_role_assignments r on r.user_id = p.user_id
  join auth.users u on u.id = p.user_id
  where p.user_id = p_user_id and p.status = 'active' and p.accepted_at is not null
    and u.email_confirmed_at is not null and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= now())
$$;
revoke all on function private.official_role_for(uuid) from public, anon, authenticated, service_role;

create function private.current_official_role()
returns public.official_role language sql stable security definer set search_path = '' as $$
  select private.official_role_for(auth.uid())
$$;

create function private.can_access_district(p_district public.official_district)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_official_role() is not null and exists (
    select 1 from public.official_district_assignments d
    where d.user_id = auth.uid() and d.district = p_district
  )
$$;
revoke all on function private.current_official_role() from public, anon;
revoke all on function private.can_access_district(public.official_district) from public, anon;
grant execute on function private.current_official_role() to authenticated;
grant execute on function private.can_access_district(public.official_district) to authenticated;

alter table public.official_profiles enable row level security;
alter table public.official_role_assignments enable row level security;
alter table public.official_district_assignments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.official_records enable row level security;

revoke all on public.official_profiles, public.official_role_assignments,
  public.official_district_assignments, public.audit_logs, public.official_records
  from public, anon, authenticated;
grant select on public.official_profiles, public.official_role_assignments,
  public.official_district_assignments, public.audit_logs, public.official_records to authenticated;
grant select, insert, update, delete on public.official_profiles, public.official_role_assignments,
  public.official_district_assignments, public.official_records to service_role;
grant select, insert on public.audit_logs to service_role;
-- Supabase may have broad default sequence grants; remove them explicitly.
revoke all on sequence public.audit_logs_id_seq from public, anon, authenticated, service_role;
grant usage, select on sequence public.audit_logs_id_seq to service_role;
revoke update, delete, truncate on public.audit_logs from service_role;

create policy profiles_read on public.official_profiles for select to authenticated
  using (user_id = auth.uid() or private.current_official_role() = 'system_admin');
create policy roles_read on public.official_role_assignments for select to authenticated
  using ((user_id = auth.uid() and private.current_official_role() is not null)
    or private.current_official_role() = 'system_admin');
create policy districts_read on public.official_district_assignments for select to authenticated
  using ((user_id = auth.uid() and private.current_official_role() is not null)
    or private.current_official_role() = 'system_admin');
create policy audits_admin_read on public.audit_logs for select to authenticated
  using (private.current_official_role() = 'system_admin');
create policy records_district_read on public.official_records for select to authenticated
  using (private.can_access_district(district));
-- Deliberately no INSERT/UPDATE/DELETE client policies, including for administrators.

create function private.audit_official_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare before_row jsonb; after_row jsonb;
begin
  if tg_op <> 'INSERT' then before_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then after_row := to_jsonb(new); end if;
  insert into public.audit_logs(actor_id, target_user_id, action, details)
  values (auth.uid(), coalesce(after_row->>'user_id', before_row->>'user_id')::uuid,
    tg_table_name || '.' || lower(tg_op),
    jsonb_build_object('before', before_row, 'after', after_row));
  return null;
end
$$;
revoke all on function private.audit_official_change() from public, anon, authenticated;
create trigger profile_audit after insert or update or delete on public.official_profiles
  for each row execute function private.audit_official_change();
create trigger role_audit after insert or update or delete on public.official_role_assignments
  for each row execute function private.audit_official_change();
create trigger district_audit after insert or update or delete on public.official_district_assignments
  for each row execute function private.audit_official_change();

create function public.get_official_context()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', p.user_id, 'email', p.invitation_email, 'status', p.status,
    'invitation_expires_at', p.invitation_expires_at,
    'role', private.current_official_role(),
    'districts', case when private.current_official_role() is null then '[]'::jsonb else
      coalesce((select jsonb_agg(d.district order by d.district)
        from public.official_district_assignments d where d.user_id = auth.uid()), '[]'::jsonb) end
  ) from public.official_profiles p where p.user_id = auth.uid()
$$;
revoke all on function public.get_official_context() from public, anon;
grant execute on function public.get_official_context() to authenticated;

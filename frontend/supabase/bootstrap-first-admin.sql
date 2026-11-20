-- MANUAL ONLY: execute as the project owner in SQL Editor, never through a public API.
-- First run the trusted local invite-first-admin.mjs script, then copy its Auth UUID.
-- Run this BEFORE the recipient accepts the email link. They set their own password.
-- Replace the NULL below with that UUID. Never put passwords in this script.
begin;
do $$
declare
  first_admin_id uuid := null; -- replace with 'copied-auth-user-uuid'::uuid
  first_admin_email text;
  first_invited_at timestamptz;
begin
  perform pg_advisory_xact_lock(714052601);
  if first_admin_id is null then raise exception 'Set the verified Auth user UUID first'; end if;
  if exists (select 1 from public.official_role_assignments where role = 'system_admin') then
    raise exception 'An administrator already exists; use the authorized management flow';
  end if;
  select email, invited_at into first_admin_email, first_invited_at from auth.users where id = first_admin_id
    and invited_at > now() - interval '1 hour' and coalesce(encrypted_password, '') = ''
    and deleted_at is null and (banned_until is null or banned_until <= now());
  if not found then raise exception 'A fresh, unaccepted Auth invitation is required'; end if;
  insert into public.official_profiles(user_id, invitation_email, invited_at, invitation_expires_at)
    values (first_admin_id, lower(first_admin_email), first_invited_at, first_invited_at + interval '1 hour');
  insert into public.official_role_assignments(user_id, role) values (first_admin_id, 'system_admin');
  -- Administrative authority alone grants no district records. Assign only approved districts.
  -- This bootstrap intentionally assigns none; a second admin may grant approved scopes later.
  insert into public.audit_logs(target_user_id, action, details)
    values (first_admin_id, 'administrator.manual_bootstrap', '{"source":"project_owner_sql_editor"}');
end
$$;
commit;

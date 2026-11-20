-- Serialize all permission changes. Recheck the actor AFTER obtaining the lock.
create function private.require_official_admin()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(714052601);
  if private.current_official_role() is distinct from 'system_admin'::public.official_role then
    raise exception 'Administrator authorization required' using errcode = '42501';
  end if;
end
$$;
revoke all on function private.require_official_admin() from public, anon, authenticated;

create function private.validate_official_scope(p_role public.official_role, p_districts public.official_district[])
returns void language plpgsql set search_path = '' as $$
begin
  if p_role is null or p_districts is null or array_position(p_districts, null) is not null
    or cardinality(p_districts) > 4 or (p_role <> 'system_admin' and cardinality(p_districts) = 0)
    or cardinality(p_districts) <> (select count(distinct d) from unnest(p_districts) d) then
    raise exception 'Invalid role or district scope' using errcode = '22023';
  end if;
end
$$;
revoke all on function private.validate_official_scope(public.official_role, public.official_district[]) from public, anon, authenticated;

create function public.begin_official_invitation(p_email text, p_role public.official_role, p_districts public.official_district[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare request_id uuid;
begin
  perform private.require_official_admin();
  perform private.validate_official_scope(p_role, p_districts);
  p_email := lower(btrim(p_email));
  if p_email is null or length(p_email) > 254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid invitation email' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users where lower(email) = p_email) then
    raise exception 'Account already exists; manage the existing account or contact the project operator' using errcode = '22023';
  end if;
  if (select count(*) from private.official_invitation_requests
      where requested_by = auth.uid() and requested_at > now() - interval '1 hour') >= 10 then
    raise exception 'Invitation rate limit reached' using errcode = '22023';
  end if;
  insert into private.official_invitation_requests(email, role, districts, requested_by)
    values (p_email, p_role, p_districts, auth.uid()) returning id into request_id;
  insert into public.audit_logs(actor_id, action, details) values (auth.uid(), 'invitation.requested',
    jsonb_build_object('request_id', request_id, 'email', p_email, 'role', p_role, 'districts', p_districts));
  return request_id;
end
$$;

-- Only the service-role caller inside the Edge Function may finalize a reservation.
-- It must carry the previously verified actor UUID, and this function rechecks live admin status.
create function public.finish_official_invitation(p_request_id uuid, p_actor_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare invitation private.official_invitation_requests%rowtype; invited_user auth.users%rowtype;
begin
  perform pg_advisory_xact_lock(714052601);
  if private.official_role_for(p_actor_id) is distinct from 'system_admin'::public.official_role then
    raise exception 'Administrator authorization revoked' using errcode = '42501';
  end if;
  select * into invitation from private.official_invitation_requests where id = p_request_id for update;
  if not found or invitation.requested_by <> p_actor_id or invitation.state <> 'pending'
    or invitation.requested_at < now() - interval '5 minutes' then
    raise exception 'Invalid invitation reservation' using errcode = '22023';
  end if;
  select * into invited_user from auth.users where id = p_user_id;
  if not found or lower(invited_user.email) is distinct from invitation.email or invited_user.invited_at is null
    or invited_user.created_at is null or invited_user.created_at < invitation.requested_at then
    raise exception 'Invalid invited identity' using errcode = '42501';
  end if;
  insert into public.official_profiles(user_id, invitation_email, invited_by, invited_at, invitation_expires_at)
    values (p_user_id, invitation.email, p_actor_id, invitation.requested_at, invitation.requested_at + interval '1 hour');
  insert into public.official_role_assignments(user_id, role, assigned_by)
    values (p_user_id, invitation.role, p_actor_id);
  insert into public.official_district_assignments(user_id, district, assigned_by)
    select p_user_id, district, p_actor_id from unnest(invitation.districts) district;
  update private.official_invitation_requests set state = 'provisioned', user_id = p_user_id where id = p_request_id;
  insert into public.audit_logs(actor_id, target_user_id, action, details)
    values (p_actor_id, p_user_id, 'invitation.provisioned', jsonb_build_object('request_id', p_request_id));
end
$$;

create function public.fail_official_invitation(p_request_id uuid, p_actor_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.official_invitation_requests set state = 'failed'
    where id = p_request_id and requested_by = p_actor_id and state = 'pending';
  if found then
    insert into public.audit_logs(actor_id, action, details) values (p_actor_id, 'invitation.failed',
      jsonb_build_object('request_id', p_request_id));
  end if;
end
$$;

create function public.complete_official_invitation()
returns void language plpgsql security definer set search_path = '' as $$
declare profile public.official_profiles%rowtype;
begin
  perform pg_advisory_xact_lock(714052601);
  select * into profile from public.official_profiles where user_id = auth.uid() for update;
  if not found or profile.status <> 'invited' or profile.invitation_expires_at <= now() then
    raise exception 'Invitation unavailable or expired' using errcode = '42501';
  end if;
  -- Password hashes stay exclusively in Supabase Auth. The application only checks that setup occurred.
  if not exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null
      and invited_at is not null and coalesce(encrypted_password, '') <> ''
      and deleted_at is null and (banned_until is null or banned_until <= now())) then
    raise exception 'Verified invitation and password setup required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.official_role_assignments where user_id = auth.uid()) then
    raise exception 'Role assignment required' using errcode = '42501';
  end if;
  update public.official_profiles set status = 'active', accepted_at = now(), updated_at = now() where user_id = auth.uid();
end
$$;

create function public.admin_update_official(p_user_id uuid, p_role public.official_role,
  p_districts public.official_district[], p_status public.official_status)
returns void language plpgsql security definer set search_path = '' as $$
declare profile public.official_profiles%rowtype;
begin
  perform private.require_official_admin();
  if p_user_id = auth.uid() then
    raise exception 'Self-management is prohibited; another administrator must make this change' using errcode = '42501';
  end if;
  perform private.validate_official_scope(p_role, p_districts);
  select * into profile from public.official_profiles where user_id = p_user_id for update;
  if not found or p_status is null then raise exception 'Invalid official' using errcode = '22023'; end if;
  if (p_status = 'active' and profile.accepted_at is null)
    or (p_status = 'invited' and profile.status <> 'invited') then
    raise exception 'Invitation acceptance cannot be bypassed or reset' using errcode = '42501';
  end if;
  update public.official_profiles set status = p_status, updated_at = now() where user_id = p_user_id;
  insert into public.official_role_assignments(user_id, role, assigned_by)
    values (p_user_id, p_role, auth.uid()) on conflict (user_id) do update
      set role = excluded.role, assigned_by = excluded.assigned_by, assigned_at = now();
  delete from public.official_district_assignments where user_id = p_user_id;
  insert into public.official_district_assignments(user_id, district, assigned_by)
    select p_user_id, d, auth.uid() from unnest(p_districts) d;
end
$$;

revoke all on function public.begin_official_invitation(text, public.official_role, public.official_district[])
  from public, anon;
revoke all on function public.complete_official_invitation() from public, anon;
revoke all on function public.admin_update_official(uuid, public.official_role, public.official_district[], public.official_status)
  from public, anon;
grant execute on function public.begin_official_invitation(text, public.official_role, public.official_district[]) to authenticated;
grant execute on function public.complete_official_invitation() to authenticated;
grant execute on function public.admin_update_official(uuid, public.official_role, public.official_district[], public.official_status) to authenticated;

revoke all on function public.finish_official_invitation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_official_invitation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finish_official_invitation(uuid, uuid, uuid) to service_role;
grant execute on function public.fail_official_invitation(uuid, uuid) to service_role;

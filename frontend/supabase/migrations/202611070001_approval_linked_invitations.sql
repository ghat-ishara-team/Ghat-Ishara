
-- GHAT ISHARA — Stage 3
-- Approval-linked officer invitations.
-- Forward-only migration.
-- Do not apply until the Edge Function has been updated.

-- The legacy direct invitation path is reserved for system
-- administrators. Ordinary officers need an approved application.

create or replace function public.begin_official_invitation(
  p_email text,
  p_role public.official_role,
  p_districts public.official_district[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_id uuid;
begin
  perform private.require_official_admin();

  if p_role is distinct from 'system_admin'::public.official_role then
    raise exception 'Officer invitations require an approved application'
      using errcode = '42501';
  end if;

  perform private.validate_official_scope(p_role, p_districts);

  p_email := lower(btrim(p_email));

  if p_email is null
     or length(p_email) > 254
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid invitation email'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from auth.users where lower(email) = p_email
  ) then
    raise exception 'Account already exists'
      using errcode = '22023';
  end if;

  if (
    select count(*)
    from private.official_invitation_requests
    where requested_by = auth.uid()
      and requested_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'Invitation rate limit reached'
      using errcode = '22023';
  end if;

  insert into private.official_invitation_requests(
    email, role, districts, requested_by
  )
  values (p_email, p_role, p_districts, auth.uid())
  returning id into request_id;

  insert into public.audit_logs(actor_id, action, details)
  values (
    auth.uid(),
    'invitation.admin_requested',
    jsonb_build_object('request_id', request_id)
  );

  return request_id;
end;
$$;


-- Reserve a new invitation using the stored approval.
-- The browser supplies only the application UUID.

create function public.begin_approved_official_invitation(
  p_application_id uuid
)
returns table (
  reservation_id uuid,
  recipient_email text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  application private.official_access_requests%rowtype;
  new_reservation uuid;
begin
  perform private.require_official_admin();

  if p_application_id is null then
    raise exception 'Application required'
      using errcode = '22023';
  end if;

  select *
    into application
    from private.official_access_requests a
   where a.id = p_application_id
   for update;

  if not found
     or application.status <> 'approved'
     or application.email_verified_at is null
     or application.approved_role is null
     or application.approved_role = 'system_admin'::public.official_role
     or application.approved_districts is null
     or application.invitation_request_id is not null
     or application.invited_user_id is not null then
    raise exception 'Application is not eligible for invitation'
      using errcode = '42501';
  end if;

  perform private.validate_official_scope(
    application.approved_role,
    application.approved_districts
  );

  if (application.approved_districts <@
      application.requested_districts) is not true then
    raise exception 'Invalid approved district scope'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from auth.users
    where lower(email) = application.email
  ) then
    raise exception 'Account already exists; manual review required'
      using errcode = '22023';
  end if;

  if (
    select count(*)
    from private.official_invitation_requests
    where requested_by = auth.uid()
      and requested_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'Invitation rate limit reached'
      using errcode = '22023';
  end if;

  insert into private.official_invitation_requests(
    email, role, districts, requested_by
  )
  values (
    application.email,
    application.approved_role,
    application.approved_districts,
    auth.uid()
  )
  returning id into new_reservation;

  update private.official_access_requests
     set invitation_request_id = new_reservation
   where id = p_application_id;

  insert into public.audit_logs(actor_id, action, details)
  values (
    auth.uid(),
    'access_request.invitation_reserved',
    jsonb_build_object(
      'application_id', p_application_id,
      'reservation_id', new_reservation
    )
  );

  return query
  select new_reservation, application.email;
end;
$$;

revoke all on function public.begin_approved_official_invitation(uuid)
  from public, anon, authenticated;

grant execute on function public.begin_approved_official_invitation(uuid)
  to authenticated;


-- Provision the user only when the reservation is valid.
-- Officer invitations must match a verified approval.

create or replace function public.finish_official_invitation(
  p_request_id uuid,
  p_actor_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation private.official_invitation_requests%rowtype;
  invited_user auth.users%rowtype;
  application private.official_access_requests%rowtype;
begin
  perform pg_advisory_xact_lock(714052601);

  if private.official_role_for(p_actor_id)
     is distinct from 'system_admin'::public.official_role then
    raise exception 'Administrator authorization revoked'
      using errcode = '42501';
  end if;

  select *
    into invitation
    from private.official_invitation_requests
   where id = p_request_id
   for update;

  if not found
     or invitation.requested_by <> p_actor_id
     or invitation.state <> 'pending'
     or invitation.requested_at < now() - interval '5 minutes' then
    raise exception 'Invalid invitation reservation'
      using errcode = '22023';
  end if;

  select *
    into invited_user
    from auth.users
   where id = p_user_id;

  if not found
     or lower(invited_user.email) is distinct from invitation.email
     or invited_user.invited_at is null
     or invited_user.created_at is null
     or invited_user.created_at < invitation.requested_at then
    raise exception 'Invalid invited identity'
      using errcode = '42501';
  end if;

  if invitation.role <> 'system_admin'::public.official_role then

    select *
      into application
      from private.official_access_requests
     where invitation_request_id = p_request_id
     for update;

    if not found
       or application.status <> 'approved'
       or application.email_verified_at is null
       or application.invited_user_id is not null
       or application.email <> invitation.email
       or application.approved_role is distinct from invitation.role
       or application.approved_districts is distinct from invitation.districts then
      raise exception 'Approved application does not match invitation'
        using errcode = '42501';
    end if;

  end if;

  insert into public.official_profiles(
    user_id, invitation_email, invited_by,
    invited_at, invitation_expires_at
  )
  values (
    p_user_id, invitation.email, p_actor_id,
    invitation.requested_at,
    invitation.requested_at + interval '1 hour'
  );

  insert into public.official_role_assignments(
    user_id, role, assigned_by
  )
  values (
    p_user_id, invitation.role, p_actor_id
  );

  insert into public.official_district_assignments(
    user_id, district, assigned_by
  )
  select p_user_id, district, p_actor_id
  from unnest(invitation.districts) district;

  update private.official_invitation_requests
     set state = 'provisioned',
         user_id = p_user_id
   where id = p_request_id;

  if invitation.role <> 'system_admin'::public.official_role then
    update private.official_access_requests
       set invited_user_id = p_user_id
     where id = application.id;
  end if;

  insert into public.audit_logs(
    actor_id, target_user_id, action, details
  )
  values (
    p_actor_id,
    p_user_id,
    'invitation.provisioned',
    jsonb_build_object('request_id', p_request_id)
  );
end;
$$;

-- List approved officer applications awaiting invitations.
-- Only active system administrators can access this queue.

create function public.admin_list_approved_access_requests(
  p_limit integer default 25
)
returns table (
  id uuid,
  full_name text,
  email text,
  approved_role public.official_role,
  approved_districts public.official_district[],
  reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_official_admin();

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid page size'
      using errcode = '22023';
  end if;

  return query
    select
      a.id,
      a.full_name,
      a.email,
      a.approved_role,
      a.approved_districts,
      a.reviewed_at
    from private.official_access_requests a
    where a.status = 'approved'
      and a.email_verified_at is not null
      and a.invitation_request_id is null
      and a.invited_user_id is null
    order by a.reviewed_at desc, a.id desc
    limit p_limit;
end;
$$;

revoke all on function public.admin_list_approved_access_requests(integer)
  from public, anon, authenticated;

grant execute on function public.admin_list_approved_access_requests(integer)
  to authenticated;

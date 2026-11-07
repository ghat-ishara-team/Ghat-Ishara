
-- GHAT ISHARA — Stage 2
-- Administrator approval and rejection of officer applications.
-- Forward-only migration. Does not send invitations or activate accounts.

create function public.admin_review_access_request(
  p_request_id uuid,
  p_decision text,
  p_role public.official_role,
  p_districts public.official_district[],
  p_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  application private.official_access_requests%rowtype;
begin
  -- Recheck the live administrator role under the existing lock.
  perform private.require_official_admin();

  if p_request_id is null
     or p_decision is null
     or p_decision not in ('approved', 'rejected') then
    raise exception 'Invalid review decision'
      using errcode = '22023';
  end if;

  -- Require review notes without accepting unbounded input.
  if p_notes is null
     or length(btrim(p_notes)) not between 10 and 1000 then
    raise exception 'Review notes must contain 10 to 1000 characters'
      using errcode = '22023';
  end if;

  -- Lock the application to prevent concurrent decisions.
  select *
    into application
    from private.official_access_requests
   where id = p_request_id
   for update;

  if not found then
    raise exception 'Application not found'
      using errcode = '22023';
  end if;

  if application.status <> 'pending'
     or application.email_verified_at is null then
    raise exception 'Application is not eligible for review'
      using errcode = '42501';
  end if;

  if p_decision = 'approved' then
    -- Ordinary access requests cannot grant system_admin.
    if p_role is null
       or p_role = 'system_admin'::public.official_role then
      raise exception 'Administrator role cannot be granted here'
        using errcode = '42501';
    end if;

    perform private.validate_official_scope(
      p_role, p_districts
    );

    -- Approval cannot exceed districts the applicant requested.
    if (p_districts <@ application.requested_districts) is not true then
      raise exception 'Approved scope exceeds requested districts'
        using errcode = '42501';
    end if;

    update private.official_access_requests
       set status = 'approved',
           reviewed_by = auth.uid(),
           reviewed_at = now(),
           review_notes = btrim(p_notes),
           approved_role = p_role,
           approved_districts = p_districts
     where id = p_request_id;

  else
    -- Rejection never assigns permissions or issues invitations.
    if p_role is not null or p_districts is not null then
      raise exception 'Rejected requests cannot assign a role or districts'
        using errcode = '22023';
    end if;

    update private.official_access_requests
       set status = 'rejected',
           reviewed_by = auth.uid(),
           reviewed_at = now(),
           review_notes = btrim(p_notes),
           approved_role = null,
           approved_districts = null
     where id = p_request_id;
  end if;

  -- Log the decision without storing applicant details or notes.
  insert into public.audit_logs (
    actor_id,
    action,
    details
  )
  values (
    auth.uid(),
    'access_request.' || p_decision,
    jsonb_build_object('request_id', p_request_id)
  );
end;
$$;

revoke all on function public.admin_review_access_request(
  uuid,
  text,
  public.official_role,
  public.official_district[],
  text
) from public, anon, authenticated;

grant execute on function public.admin_review_access_request(
  uuid,
  text,
  public.official_role,
  public.official_district[],
  text
) to authenticated;

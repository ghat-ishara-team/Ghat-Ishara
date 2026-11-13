
-- GHAT ISHARA — Administrator access-request review
-- Stage 2, Part 1: read-only pending application queue.
-- This is a new forward-only migration.

create function public.admin_list_access_requests(
  p_limit integer default 25,
  p_before_submitted_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  id uuid,
  full_name text,
  email text,
  department text,
  designation text,
  reason text,
  requested_districts public.official_district[],
  submitted_at timestamptz,
  email_verified_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Reuse the existing live administrator authorization.
  perform private.require_official_admin();

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid page size'
      using errcode = '22023';
  end if;

  if (p_before_submitted_at is null) <>
     (p_before_id is null) then
    raise exception 'Invalid pagination cursor'
      using errcode = '22023';
  end if;

  return query
    select
      r.id,
      r.full_name,
      r.email,
      r.department,
      r.designation,
      r.reason,
      r.requested_districts,
      r.submitted_at,
      r.email_verified_at
    from private.official_access_requests as r
    where r.status = 'pending'
      and r.email_verified_at is not null
      and (
        p_before_submitted_at is null
        or (r.submitted_at, r.id) <
           (p_before_submitted_at, p_before_id)
      )
    order by r.submitted_at desc, r.id desc
    limit p_limit;
end;
$$;

revoke all on function public.admin_list_access_requests(
  integer, timestamptz, uuid
) from public, anon, authenticated;

grant execute on function public.admin_list_access_requests(
  integer, timestamptz, uuid
) to authenticated;

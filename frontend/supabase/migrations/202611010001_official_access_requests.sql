-- Stage 1 only: private applications and email ownership, never Auth accounts or roles.
create table private.official_access_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(btrim(full_name)) between 1 and 120),
  email text not null unique check (email = lower(btrim(email)) and length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  department text not null check (length(btrim(department)) between 1 and 160),
  designation text not null check (length(btrim(designation)) between 1 and 120),
  reason text not null check (length(btrim(reason)) between 20 and 2000),
  requested_districts public.official_district[] not null check (cardinality(requested_districts) between 1 and 4),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_at timestamptz not null default now(),
  email_verified_at timestamptz,
  verification_hash text unique check (verification_hash is null or verification_hash ~ '^[a-f0-9]{64}$'),
  verification_expires_at timestamptz,
  -- Reserved for future reviewed operations. No Stage 1 API can set these fields.
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_notes text,
  approved_role public.official_role,
  approved_districts public.official_district[],
  invitation_request_id uuid unique references private.official_invitation_requests(id),
  invited_user_id uuid unique references auth.users(id),
  check (status <> 'approved' or (email_verified_at is not null and reviewed_by is not null and reviewed_at is not null and approved_role is not null and approved_districts is not null)),
  check (email_verified_at is null or verification_hash is null)
);
create index access_requests_review_queue on private.official_access_requests(submitted_at, id)
  where status = 'pending' and email_verified_at is not null;

create table private.official_access_request_limits (
  bucket text not null,
  window_start timestamptz not null,
  attempts integer not null check (attempts > 0),
  primary key (bucket, window_start)
);
alter table private.official_access_requests enable row level security;
alter table private.official_access_request_limits enable row level security;
-- Even the Edge service uses narrow RPCs, not direct table access.
revoke all on private.official_access_requests, private.official_access_request_limits from public, anon, authenticated, service_role;

create function private.access_request_budget(p_bucket text, p_window timestamptz, p_limit integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare used integer;
begin
  insert into private.official_access_request_limits values (p_bucket, p_window, 1)
  on conflict (bucket, window_start) do update set attempts = least(private.official_access_request_limits.attempts + 1, p_limit + 1)
  returning attempts into used;
  return used <= p_limit;
end $$;
revoke all on function private.access_request_budget(text, timestamptz, integer) from public, anon, authenticated, service_role;

create function public.submit_official_access_request(p_application jsonb, p_verification_hash text, p_email_bucket text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare fields text[] := array['fullName','email','department','designation','reason','districts'];
  field text; maximum integer; scope public.official_district[]; existing private.official_access_requests%rowtype;
  allowed boolean; global_allowed boolean; daily_allowed boolean;
begin
  if jsonb_typeof(p_application) is distinct from 'object' or p_verification_hash is null or p_verification_hash !~ '^[a-f0-9]{64}$'
    or p_email_bucket is null or p_email_bucket !~ '^[a-f0-9]{64}$' then raise exception 'Invalid application' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_object_keys(p_application) k where not (k = any(fields))) then raise exception 'Invalid application' using errcode = '22023'; end if;
  foreach field in array fields[1:5] loop
    maximum := case field when 'fullName' then 120 when 'email' then 254 when 'department' then 160 when 'designation' then 120 else 2000 end;
    if jsonb_typeof(p_application->field) is distinct from 'string' or length(btrim(p_application->>field)) not between 1 and maximum
      or translate(p_application->>field, chr(9) || chr(10) || chr(13), '') ~ '[[:cntrl:]]' then raise exception 'Invalid application' using errcode = '22023'; end if;
  end loop;
  if length(btrim(p_application->>'reason')) < 20 or (p_application->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or jsonb_typeof(p_application->'districts') is distinct from 'array' then raise exception 'Invalid application' using errcode = '22023'; end if;
  if jsonb_array_length(p_application->'districts') not between 1 and 4 or exists (
    select 1 from jsonb_array_elements(p_application->'districts') d
    where jsonb_typeof(d) <> 'string' or d #>> '{}' not in ('Pune','Raigad','Ratnagiri','Satara')
  ) then raise exception 'Invalid districts' using errcode = '22023'; end if;
  select array_agg(d::public.official_district) into scope from jsonb_array_elements_text(p_application->'districts') d;
  if cardinality(scope) <> (select count(distinct d) from unnest(scope) d) then raise exception 'Invalid districts' using errcode = '22023'; end if;
  -- Bound abuse without trusting spoofable browser IP headers. Serialize duplicate submissions.
  perform pg_advisory_xact_lock(714052602);
  delete from private.official_access_request_limits where window_start < now() - interval '2 days';
  global_allowed := private.access_request_budget('submit:global', date_trunc('hour', now()), 100);
  daily_allowed := private.access_request_budget('submit:daily', date_trunc('day', now()), 1000);
  if not global_allowed or not daily_allowed then return false; end if;
  allowed := private.access_request_budget('submit:email:' || p_email_bucket, date_trunc('hour', now()), 3);
  if not allowed then return false; end if;
  select * into existing from private.official_access_requests where email = lower(btrim(p_application->>'email')) for update;
  if found then
    if existing.status <> 'pending' or existing.email_verified_at is not null or existing.verification_expires_at > now() then return false; end if;
    -- Expired unverified applications may be corrected by a new submission. Approval still needs verification.
    update private.official_access_requests set full_name = btrim(p_application->>'fullName'), department = btrim(p_application->>'department'),
      designation = btrim(p_application->>'designation'), reason = btrim(p_application->>'reason'), requested_districts = scope,
      verification_hash = p_verification_hash, verification_expires_at = now() + interval '20 minutes', submitted_at = now()
      where id = existing.id;
  else
    insert into private.official_access_requests(full_name,email,department,designation,reason,requested_districts,verification_hash,verification_expires_at)
      values (btrim(p_application->>'fullName'),lower(btrim(p_application->>'email')),btrim(p_application->>'department'),
        btrim(p_application->>'designation'),btrim(p_application->>'reason'),scope,p_verification_hash,now() + interval '20 minutes');
  end if;
  return true;
end $$;

create function public.verify_official_access_request(p_verification_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer; allowed boolean;
begin
  if p_verification_hash is null or p_verification_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  perform pg_advisory_xact_lock(714052602);
  delete from private.official_access_request_limits where window_start < now() - interval '2 days';
  allowed := private.access_request_budget('verify:global', date_trunc('hour', now()), 1000);
  if not allowed then return false; end if;
  update private.official_access_requests set email_verified_at = now(), verification_hash = null
    where verification_hash = p_verification_hash and status = 'pending' and email_verified_at is null and verification_expires_at > now();
  get diagnostics changed = row_count;
  return changed = 1;
end $$;
revoke all on function public.submit_official_access_request(jsonb,text,text) from public, anon, authenticated;
revoke all on function public.verify_official_access_request(text) from public, anon, authenticated;
grant execute on function public.submit_official_access_request(jsonb,text,text) to service_role;
grant execute on function public.verify_official_access_request(text) to service_role;

// Pure local guards and private SQL preparation. No database or Auth calls.
export const LOCAL_AUTH_ORIGIN = 'http://127.0.0.1:54321'
export function assertLocalRecoveryTarget(url, redirect) {
  if (new URL(url).href !== `${LOCAL_AUTH_ORIGIN}/`) throw new Error('Recovery only supports the exact local Supabase API origin.')
  const destination = new URL(redirect)
  if (destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1'
    || !['5173', '4173'].includes(destination.port) || destination.pathname !== '/official/accept-invite'
    || destination.username || destination.password || destination.search || destination.hash) throw new Error('Recovery requires an exact local frontend invitation URL.')
}
export function assertRecoveryCandidate(user, email, profiles, roles) {
  if (!user || user.email?.toLowerCase() !== email || !user.invited_at
    || user.email_confirmed_at || user.phone_confirmed_at || user.confirmed_at || user.last_sign_in_at
    || user.deleted_at || (user.banned_until && new Date(user.banned_until).getTime() > Date.now())
    || profiles !== 0 || roles !== 0) throw new Error('Recovery requires the original unconfirmed invitation and no official profiles/roles. Stop and re-inspect.')
}
export function createPrivateRecoverySQL(source, userId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new Error('Invalid private identity.')
  const marker = 'first_admin_id uuid := null;'
  if (source.split(marker).length !== 2) throw new Error('Bootstrap template must contain exactly one safe null UUID placeholder.')
  const bootstrap = `\\set ON_ERROR_STOP on\n\\set VERBOSITY terse\n${source.replace(marker, `first_admin_id uuid := '${userId}'::uuid;`)}`
  const verify = `\\set ON_ERROR_STOP on
\\set VERBOSITY terse
begin read only;
do $$
declare target_id uuid := '${userId}'::uuid;
begin
  if not exists (
    select 1 from public.official_profiles p
    join public.official_role_assignments r on r.user_id = p.user_id
    join auth.users u on u.id = p.user_id
    where p.user_id = target_id and p.status = 'invited' and p.accepted_at is null
      and r.role = 'system_admin' and p.invited_at = u.invited_at
      and p.invitation_expires_at = u.invited_at + interval '1 hour'
      and p.invitation_expires_at > now() and u.invited_at > now() - interval '1 hour'
      and u.email_confirmed_at is null and coalesce(u.encrypted_password, '') = ''
      and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
  ) or (select count(*) from public.official_profiles) <> 1
    or (select count(*) from public.official_role_assignments) <> 1
    or exists (select 1 from public.official_district_assignments where user_id = target_id) then
    raise exception 'Recovery verification failed. Do not open the invitation; inspect local state privately.';
  end if;
end
$$;
select 'READY_FOR_PASSWORD_SETUP' as recovery_check;
rollback;
`
  return { bootstrap, verify }
}

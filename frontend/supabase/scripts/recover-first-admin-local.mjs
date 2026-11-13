// LOCAL DEVELOPMENT ONLY. Default inspection uses GET/HEAD only.
// --prepare writes private files, never SQL. --invite is an explicit Auth write.
// No mode executes SQL, deletes a user, sets a password or prints a UUID/token.
import { createClient } from '@supabase/supabase-js'
import { mkdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises'
import { readBootstrapConfig } from './bootstrap-config.mjs'
import { assertLocalRecoveryTarget, assertRecoveryCandidate, createPrivateRecoverySQL, LOCAL_AUTH_ORIGIN } from './local-recovery-plan.mjs'

class RecoveryError extends Error {}
const mode = process.argv[2] ?? '--inspect'
const directory = new URL('../.local-recovery/', import.meta.url)
try {
  if (!['--inspect', '--prepare', '--invite'].includes(mode) || process.argv.length > 3) throw new RecoveryError('Use --inspect, --prepare or --invite. No other recovery actions are supported.')
  let config
  try {
    config = readBootstrapConfig(process.env)
    assertLocalRecoveryTarget(config.url, config.redirect)
  } catch { throw new RecoveryError('Invalid recovery configuration. Use the exact local API and local frontend URLs in supabase/bootstrap.env.local. Hosted targets are refused.') }
  const guardedFetch = async (input, init = {}) => {
    const address = new URL(input instanceof Request ? input.url : String(input))
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (address.origin !== LOCAL_AUTH_ORIGIN || address.username || address.password
      || (!['GET', 'HEAD'].includes(method) && !(mode === '--invite' && method === 'POST' && address.pathname === '/auth/v1/invite'))) {
      throw new RecoveryError('Recovery blocked a non-local or unauthorized request.')
    }
    return fetch(input, { ...init, redirect: 'error' })
  }
  const client = createClient(config.url, config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: guardedFetch },
  })
  const [identities, profiles, roles] = await Promise.all([
    client.auth.admin.listUsers({ page: 1, perPage: 2 }),
    client.from('official_profiles').select('user_id', { count: 'exact', head: true }),
    client.from('official_role_assignments').select('user_id', { count: 'exact', head: true }),
  ])
  if (identities.error || profiles.error || roles.error) throw new RecoveryError('Local read-only inspection failed. Verify the local service key and applied schema privately.')
  const users = identities.data.users
  if (users.length !== 1) throw new RecoveryError('Expected exactly one local Auth user. Stop and inspect privately; nothing was changed.')
  const user = users[0]
  try { assertRecoveryCandidate(user, config.email, profiles.count, roles.count) }
  catch { throw new RecoveryError('State is not eligible for this recovery: require the configured original recipient, unconfirmed unused invitation and zero official profiles/roles. Nothing was changed.') }
  if (mode === '--inspect') {
    console.log(JSON.stringify({ localOnly: true, originalRecipientMatches: true, unconfirmedInvitation: true,
      invitationWithinOneHour: new Date(user.invited_at).getTime() > Date.now() - 3600000,
      officialProfiles: profiles.count, roleAssignments: roles.count, mutationsPerformed: false }))
  } else if (mode === '--prepare') {
    const source = await readFile(new URL('../bootstrap-first-admin.sql', import.meta.url), 'utf8')
    const sql = createPrivateRecoverySQL(source, user.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RecoveryError('Recovery directory must be a private real directory.')
    await chmod(directory, 0o700)
    // Exclusive creation avoids overwriting an earlier/user-authored plan.
    await writeFile(new URL('plan.json', directory), JSON.stringify({ userId: user.id }), { mode: 0o600, flag: 'wx' })
    await writeFile(new URL('bootstrap.sql', directory), sql.bootstrap, { mode: 0o600, flag: 'wx' })
    await writeFile(new URL('verify.sql', directory), sql.verify, { mode: 0o600, flag: 'wx' })
    console.log('Prepared private recovery files in supabase/.local-recovery/ (directory 0700, files 0600). No Auth or SQL writes performed. Do not print or share their contents.')
  } else {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new RecoveryError('Prepare a private recovery plan first.')
    let plan
    for (const name of ['plan.json', 'bootstrap.sql', 'verify.sql']) {
      const file = new URL(name, directory)
      const metadata = await lstat(file)
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new RecoveryError('Recovery files must be private regular files.')
      if (name === 'plan.json') plan = JSON.parse(await readFile(file, 'utf8'))
    }
    if (plan.userId !== user.id) throw new RecoveryError('The private plan targets a different identity. Stop; nothing was changed.')
    const { data, error } = await client.auth.admin.inviteUserByEmail(config.email, { redirectTo: config.redirect })
    if (error || !data.user) throw new RecoveryError('Local re-invitation did not complete. Inspect the local state privately; do not delete or blindly retry.')
    if (data.user.id !== user.id || data.user.email_confirmed_at
      || !(new Date(data.user.invited_at).getTime() > new Date(user.invited_at).getTime())) {
      throw new RecoveryError('Unexpected local re-invitation result. Do not execute the prepared SQL; inspect privately.')
    }
    console.log('Fresh local invitation issued for the SAME Auth identity. No deletion or SQL writes performed. Do not open the email until bootstrap.sql and verify.sql succeed.')
  }
} catch (error) {
  console.error(error instanceof RecoveryError ? error.message : 'Local recovery stopped safely. Inspect private configuration/plan files locally; provider details and identifiers were not printed.')
  process.exitCode = 1
}

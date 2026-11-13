// Executes the real migrations in isolated, in-memory PostgreSQL (PGlite).
// The small auth schema below is a TEST STUB, not a substitute for Supabase Auth.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let checks = 0
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); ++checks }
async function acting(userId, sql, params = [], commit = false, role = 'authenticated') {
  await db.exec(`begin; set local role ${role};`)
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ''])
    const result = await db.query(sql, params)
    await db.exec(commit ? 'commit' : 'rollback')
    return result.rows
  } catch (error) {
    await db.exec('rollback')
    throw error
  }
}
async function denied(userId, sql, params = [], role = 'authenticated') {
  await assert.rejects(() => acting(userId, sql, params, false, role), error => ['42501', '22023', '23505'].includes(error.code))
  ++checks
}
async function authUser(n, password = true) {
  await db.query(`insert into auth.users(id,email,invited_at,created_at,email_confirmed_at,encrypted_password,raw_user_meta_data)
    values ($1,$2,now(),now(),case when $3 then now() else null end,case when $3 then 'TEST_AUTH_HASH_STUB' else '' end,'{"role":"system_admin","districts":["Pune"]}')`,
  [id(n), `demo.official.${n}@example.invalid`, password])
}
async function fixture(n, role, scope, status = 'active') {
  await authUser(n)
  await db.query(`insert into public.official_profiles(user_id,invitation_email,status,accepted_at)
    values ($1,$2,$3::public.official_status,case when $3::public.official_status = 'active' then now() else null end)`, [id(n), `demo.official.${n}@example.invalid`, status])
  await db.query('insert into public.official_role_assignments(user_id,role) values ($1,$2)', [id(n), role])
  for (const district of scope) await db.query('insert into public.official_district_assignments(user_id,district) values ($1,$2)', [id(n), district])
}

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text, invited_at timestamptz, created_at timestamptz,
      email_confirmed_at timestamptz, encrypted_password text, raw_user_meta_data jsonb,
      banned_until timestamptz, deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    -- Exercise explicit revokes against broad Supabase-style defaults, not just bare PostgreSQL defaults.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`)
  for (const filename of ['202610240001_official_permissions.sql', '202610240002_official_management.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${filename}`, import.meta.url), 'utf8'))
  }
  ++checks
  await authUser(1, false)
  const bootstrap = (await readFile(new URL('../supabase/bootstrap-first-admin.sql', import.meta.url), 'utf8'))
    .replace('first_admin_id uuid := null;', `first_admin_id uuid := '${id(1)}';`)
  const bootstrapBlock = bootstrap.slice(bootstrap.indexOf('do $$'), bootstrap.lastIndexOf('$$;') + 3)
  await denied(id(1), bootstrapBlock)
  await db.query("update auth.users set banned_until = now() + interval '1 hour' where id=$1", [id(1)])
  await assert.rejects(() => db.exec(bootstrap), error => error.code === 'P0001')
  await db.exec('rollback'); ++checks
  await db.query('update auth.users set banned_until = null where id=$1', [id(1)])
  await db.exec(bootstrap)
  await assert.rejects(() => db.exec(bootstrap), error => error.code === 'P0001')
  await db.exec('rollback'); ++checks
  equal((await acting(id(1), 'select public.get_official_context() as context'))[0].context.role, null, 'Bootstrap is pending, not active')
  await denied(id(1), 'select public.complete_official_invitation()')
  await db.query("update auth.users set email_confirmed_at = now(), encrypted_password = 'TEST_AUTH_HASH_STUB' where id = $1", [id(1)])
  await acting(id(1), 'select public.complete_official_invitation()', [], true)
  equal((await acting(id(1), 'select public.get_official_context() as context'))[0].context.role, 'system_admin', 'Bootstrap requires real acceptance')
  await fixture(2, 'district_officer', ['Pune'])
  await fixture(3, 'senior_officer', ['Raigad', 'Satara'])
  await fixture(4, 'district_officer', ['Pune'], 'inactive')
  await fixture(5, 'district_officer', ['Ratnagiri'], 'invited')
  await fixture(6, 'district_officer', ['Satara'], 'invited')
  await fixture(8, 'system_admin', [])
  await authUser(7) // Deliberately no profile, despite forged admin user metadata.
  await db.query("update public.official_profiles set invitation_expires_at = now() - interval '1 second' where user_id = $1", [id(6)])
  for (const district of ['Pune', 'Raigad', 'Ratnagiri', 'Satara']) {
    await db.query('insert into public.official_records(district,title) values ($1,$2)', [district, `DEMO ONLY: ${district} test record`])
  }

  await denied(null, 'select * from public.official_records', [], 'anon')
  equal((await acting(id(2), 'select district from public.official_records')).map(row => row.district), ['Pune'], 'District officer scope')
  equal((await acting(id(3), 'select district from public.official_records order by district')).map(row => row.district), ['Raigad', 'Satara'], 'Senior officer scope')
  for (const n of [1, 4, 5, 6, 7, 8]) equal(await acting(id(n), 'select * from public.official_records'), [], `Fail closed / no implicit admin district scope: ${n}`)
  equal((await acting(id(7), 'select public.get_official_context() as context'))[0].context, null, 'Metadata/email do not authorize')
  equal(await acting(id(2), 'select * from public.audit_logs'), [], 'Officer cannot read audit log')
  equal((await acting(id(2), 'select user_id from public.official_profiles')).length, 1, 'Profile self read only')
  equal((await acting(id(1), 'select user_id from public.official_profiles')).length, 7, 'Admin profile review')
  await denied(id(2), "update public.official_role_assignments set role = 'system_admin' where user_id = $1", [id(2)])
  await denied(id(1), "update public.official_profiles set status = 'inactive' where user_id = $1", [id(2)])
  await denied(id(1), "delete from public.audit_logs")
  await denied(id(2), "select public.admin_update_official($1,'system_admin','{}','active')", [id(2)])
  await denied(id(1), "select public.admin_update_official($1,'system_admin','{}','inactive')", [id(1)])
  await denied(id(1), "select public.admin_update_official($1,'district_officer','{}','active')", [id(2)])
  await denied(id(1), "select public.admin_update_official($1,'district_officer','{Pune}','active')", [id(5)])
  await denied(id(6), 'select public.complete_official_invitation()')
  await denied(id(4), 'select public.complete_official_invitation()')
  await denied(id(7), 'select public.complete_official_invitation()')
  await denied(id(1), 'select public.complete_official_invitation()')
  await acting(id(1), "select public.admin_update_official($1,'district_officer','{Ratnagiri}','inactive')", [id(5)], true)
  await denied(id(5), 'select public.complete_official_invitation()')
  equal(await acting(id(5), 'select * from public.official_records'), [], 'Revoked invitation has no data access')
  await denied(id(1), "select setval('public.audit_logs_id_seq', 1)")
  await denied(id(1), 'select private.official_role_for($1)', [id(2)])
  await denied(id(1), "insert into public.official_records(district,title) values ('Pune','DEMO forbidden insert')")
  equal((await db.query("select has_function_privilege('anon','public.get_official_context()','execute') as allowed")).rows[0].allowed, false)
  equal((await db.query("select has_function_privilege('authenticated','public.finish_official_invitation(uuid,uuid,uuid)','execute') as allowed")).rows[0].allowed, false)
  equal((await db.query("select has_sequence_privilege('anon','public.audit_logs_id_seq','update') as allowed")).rows[0].allowed, false)
  for (const column of ['banned_until', 'deleted_at', 'email_confirmed_at']) {
    const change = column === 'banned_until' ? "now() + interval '1 hour'" : column === 'deleted_at' ? 'now()' : 'null'
    await db.query(`update auth.users set ${column} = ${change} where id = $1`, [id(2)])
    equal(await acting(id(2), 'select * from public.official_records'), [], `Auth ${column} respected with same JWT subject`)
    await db.query(`update auth.users set ${column} = ${column === 'email_confirmed_at' ? 'now()' : 'null'} where id = $1`, [id(2)])
  }
  await denied(id(2), "select public.begin_official_invitation('demo.new@example.invalid','district_officer','{Pune}')")
  await denied(id(1), "select public.begin_official_invitation('demo.official.7@example.invalid','system_admin','{}')")

  const reservation = (await acting(id(1), "select public.begin_official_invitation('demo.official.9@example.invalid','district_officer','{Pune}') as id", [], true))[0].id
  await authUser(9, false)
  await denied(id(1), 'select public.finish_official_invitation($1,$2,$3)', [reservation, id(1), id(9)])
  await authUser(11, false)
  await denied(null, 'select public.finish_official_invitation($1,$2,$3)', [reservation, id(1), id(11)], 'service_role')
  await db.query('update auth.users set email=null where id=$1', [id(11)])
  await denied(null, 'select public.finish_official_invitation($1,$2,$3)', [reservation, id(1), id(11)], 'service_role')
  await db.query('update auth.users set created_at=null where id=$1', [id(9)])
  await denied(null, 'select public.finish_official_invitation($1,$2,$3)', [reservation, id(1), id(9)], 'service_role')
  await db.query('update auth.users set created_at=now() where id=$1', [id(9)])
  await acting(null, 'select public.finish_official_invitation($1,$2,$3)', [reservation, id(1), id(9)], true, 'service_role')
  equal((await acting(id(9), 'select public.get_official_context() as context'))[0].context.status, 'invited', 'Service provisioned invitation is pending')
  await denied(id(9), 'select public.complete_official_invitation()')
  await db.query("update auth.users set email_confirmed_at=now(), encrypted_password='TEST_AUTH_HASH_STUB' where id=$1", [id(9)])
  await db.query("update auth.users set banned_until = now() + interval '1 hour' where id=$1", [id(9)])
  await denied(id(9), 'select public.complete_official_invitation()')
  await db.query('update auth.users set banned_until = null where id=$1', [id(9)])
  await acting(id(9), 'select public.complete_official_invitation()', [], true)
  equal((await acting(id(9), 'select district from public.official_records')).map(row => row.district), ['Pune'])

  // Same auth UID/claims before and after mutation: no token refresh needed for revocation.
  await acting(id(1), "select public.admin_update_official($1,'district_officer','{Raigad}','active')", [id(2)], true)
  equal((await acting(id(2), 'select district from public.official_records')).map(row => row.district), ['Raigad'], 'Live district reassignment')
  await acting(id(1), "select public.admin_update_official($1,'district_officer','{Raigad}','inactive')", [id(2)], true)
  equal(await acting(id(2), 'select * from public.official_records'), [], 'Immediate inactive restriction')
  await db.query('delete from public.official_role_assignments where user_id=$1', [id(3)])
  equal(await acting(id(3), 'select * from public.official_records'), [], 'Immediate role revocation')
  const outstanding = (await acting(id(1), "select public.begin_official_invitation('demo.official.10@example.invalid','district_officer','{Pune}') as id", [], true))[0].id
  await authUser(10, false)
  await db.query("update auth.users set banned_until = now() + interval '1 hour' where id=$1", [id(1)])
  await denied(id(1), "select public.begin_official_invitation('demo.banned@example.invalid','system_admin','{}')")
  await denied(null, 'select public.finish_official_invitation($1,$2,$3)', [outstanding, id(1), id(10)], 'service_role')
  await db.query('update auth.users set banned_until = null where id=$1', [id(1)])
  await acting(id(8), "select public.admin_update_official($1,'district_officer','{Pune}','active')", [id(1)], true)
  await denied(id(1), "select public.begin_official_invitation('demo.denied@example.invalid','system_admin','{}')")
  await denied(null, 'select public.finish_official_invitation($1,$2,$3)', [outstanding, id(1), id(10)], 'service_role')
  const actions = (await acting(id(8), 'select distinct action from public.audit_logs')).map(row => row.action)
  for (const action of ['administrator.manual_bootstrap', 'invitation.requested', 'invitation.provisioned', 'official_profiles.update', 'official_role_assignments.update', 'official_district_assignments.delete']) {
    equal(actions.includes(action), true, `Audited ${action}`)
  }
  console.log(`PASS: ${checks} migration, bootstrap, RLS, district scope, invitation, privilege and revocation checks in isolated PostgreSQL.`)
  console.log('Supabase Auth, email delivery and deployed Edge Function behavior require a configured integration environment.')
} catch (error) {
  console.error('Permission verification failed:', error.message, error.code ?? '')
  process.exitCode = 1
} finally { await db.close() }

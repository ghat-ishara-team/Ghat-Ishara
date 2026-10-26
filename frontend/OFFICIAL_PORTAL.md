# Official Authentication Portal

For the shortest path from the current configured frontend to a working invited demo login, follow [FIRST_DEMO_LOGIN.md](./FIRST_DEMO_LOGIN.md). It labels the exact live steps requiring your credentials; none have been performed by the assistant.

## Current status

The public landing page, image, animations and public routes remain in place. Official pages are lazy-loaded so the Supabase SDK is not loaded by public-only visitors. The public navigation now includes **Official Login**.

Implemented: password sign-in, invitation acceptance/password setup, auth state handling, logout, protected dashboard, administrator navigation, invitation form, account status/role/district management, audit-log review, versioned migrations, district RLS, a trusted invitation Edge Function and a manual first-admin procedure.

Tested locally: frontend TypeScript and production build; Deno type-check plus seven offline Edge handler tests; 65 PostgreSQL migration/RLS/permission/bootstrap checks using PGlite and a **test-only stub of `auth.users`/`auth.uid()`** with broad Supabase-style default grants; four negative public-environment build probes and browser-bundle scanning; public navigation and unconfigured official pages in Chromium, route redirects, responsive layouts and automated accessibility checks. These tests do not prove hosted Supabase integration. See [the pre-migration review](./AUTH_REVIEW.md) for findings and fixes.

**Live project status is unverified.** Public URL/publishable-key settings are present in the ignored `.env.local`; that file was left unchanged. Their presence does not verify the hosted database, function, SMTP or Auth settings. No project migrations, user creation, invitations or live sign-in were performed during the review. Live login, token expiry/replay, password setup, SMTP and hosted API/Edge enforcement must be tested against a dedicated Supabase test project before deployment. MFA enrollment/challenge UI and password recovery are not included in this milestone.

## Architecture and security boundaries

- Supabase Auth owns credentials, verification, password hashing, session tokens and email tokens. No password is stored in an application table.
- `official_profiles` stores invitation identity (Auth UUID), status and acceptance timestamps. The email is an informational invitation snapshot, **never an authorization predicate**.
- `official_role_assignments` stores exactly one of `district_officer`, `senior_officer`, `system_admin` for each official.
- `official_district_assignments` stores approved Pune, Raigad, Ratnagiri and Satara assignments.
- `audit_logs` receives append-only application permission-change events. Ordinary clients, including administrators, cannot insert, edit or delete these rows.
- `official_records` is an initially empty, minimal district-scoped resource contract. The dashboard reads it under RLS; no operational records or ML outputs have been integrated. This policy does **not** automatically secure future tables, file buckets, APIs or GeoTIFFs. Apply equivalent checks to each future protected resource.
- An active accepted profile, a current database role and a matching district assignment are required for every protected record query. **Senior officers are limited to their assignments, not all districts.** Administrators receive no implicit record access; an administrator with zero districts can manage accounts/audits but sees no district records.
- Role/status/district changes take effect on subsequent database statements with the same JWT. RLS also checks confirmed email, `auth.users.banned_until` and soft deletion through a shared internal role lookup. Provisioning rechecks the inviting administrator's Auth state; acceptance rejects disabled recipient identities. JWT metadata, `user_metadata`, email domains and browser state are not authorization sources. UI route guards only improve the experience.
- Only an authenticated active administrator can reserve an invitation. The Edge Function verifies the caller with Supabase Auth and invokes `begin_official_invitation` as that caller. It then uses its server-only service key for `inviteUserByEmail` and finalizes provisioning through a service-only RPC that **rechecks** the administrator. Reservations are limited to ten per administrator per hour. Existing Auth identities are rejected rather than silently upgraded by email.
- Management uses `admin_update_official`, a `SECURITY DEFINER` database function with an empty `search_path`, live administrator validation and strict role/district/status validation. Clients have SELECT-only grants and no write policies. Even administrators cannot change their own profile, role, scope or status. Permission changes are serialized under a transaction advisory lock; no ordinary client can bootstrap an admin.
- The first administrator is a deliberate, manual project-owner operation outside public APIs. Keep a second approved administrator for account recovery and changes to the first administrator.
- Uninvited/inactive users may read their own minimal profile/status to explain blocked access; they cannot read records, other profiles, assignments or audit logs. Inactivation restricts application data immediately; it does not delete their Supabase Auth identity or remove information previously downloaded.
- Sessions use Supabase's browser storage and refresh behavior. Host over HTTPS and maintain strong XSS protections; never put credentials, tokens or invitation URLs in analytics, support screenshots or logs. Global `Referrer-Policy` equivalent is supplied through the HTML `no-referrer` meta tag; set an HTTP `Referrer-Policy: no-referrer` header at the host as well.

## 1. Configure a dedicated Supabase project

Use a test project first. Install the Supabase CLI following its official setup instructions. The commands below are **operator instructions**, not actions already performed by this implementation.

In Supabase Authentication settings:

1. Disable **Allow new users to sign up**, anonymous sign-ins and unused auth providers. Invitations are issued through the trusted admin flow only.
2. Enable email/password authentication and email verification. Set minimum password length to **12**, enable appropriate strength/leaked-password controls available to your project, and configure Auth rate limits. The UI requires 12–128 characters; Supabase remains the password-policy authority.
3. Set email OTP/invitation expiry to **3600 seconds**. The application also enforces one hour from the reservation. Changing the UI text alone does not change these limits; coordinate settings, SQL and email template if changing expiry later.
4. Configure reliable custom SMTP and test sender identity/delivery. Verify production delivery and rate limits instead of assuming an accepted SMTP request was delivered.
5. Set the production **Site URL** to your exact HTTPS origin.
6. Add exact invitation redirect URLs to the Auth redirect allow list, such as `https://your-approved-host/official/accept-invite`. For development, use `http://127.0.0.1:5173/official/accept-invite` (or port 4173 for production preview). `localhost` and `127.0.0.1` are different origins; do not mix them. Avoid wildcard production redirects.
7. Replace the **Invite user** email template with [supabase/templates/invite.html](./supabase/templates/invite.html). Its link must use the approved redirect and the **fragment**:

   ```html
   <a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=invite">Accept invitation</a>
   ```

The portal intentionally does not accept default implicit-session URLs. It captures this fragment in memory and immediately removes it from the address bar. No token is sent to the frontend host through the request URL. Token verification occurs only when the recipient submits the password form, so merely visiting the page does not consume the link. Supabase verifies expiry and single-use validity; the database checks invitation status/deadline before activation. URL fragments are still sensitive: do not copy or log complete invitation links.

`supabase/config.toml` provides matching **local** defaults. Applying SQL migrations does not configure hosted Auth, SMTP or email templates; configure those in the hosted project explicitly.

## 2. Environment variables

Copy `.env.example` to `.env.local` in `frontend/` and supply only public browser values:

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

Use the project publishable key (`sb_publishable_…`) or legacy **anon** key. A publishable/anon key identifies the project, not an official; RLS supplies authorization. Do not put a service-role key, secret key, SMTP password or database password in any `VITE_` variable. All Vite values are public at build time. Vite configuration now rejects recognizable secret/service-role values and obvious server-secret variable names before bundling, without printing their values. The runtime check remains defense in depth. These checks are not a general secret detector. If any secret reached a previous build or deployment, rotate it and rebuild/redeploy.

Missing/invalid configuration leaves sign-in visibly disabled and does not emulate authentication. Restart Vite after changing environment variables; rebuild a production bundle after changing them.

Edge Function custom secrets, as shown in `supabase/.env.example`:

```dotenv
SITE_URL=http://127.0.0.1:5173
OFFICIAL_INVITE_REDIRECT_URL=http://127.0.0.1:5173/official/accept-invite
```

For production, replace these with the exact HTTPS origin and corresponding path, with no trailing slash on `SITE_URL`, query string, credentials or fragment. They must match both the browser deployment and Supabase's redirect allow list. The browser cannot choose another redirect. Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to the hosted Edge runtime; never try to expose these server secrets through frontend variables. The function requires an authenticated user JWT, **not** the publishable key alone.

## 3. Apply migrations and deploy the trusted function

From `frontend/`, after reviewing the target project:

```bash
npx supabase login
npx supabase link --project-ref YOUR_TEST_PROJECT_REF
npx supabase migration list
npx supabase db push --dry-run
npx supabase db push
```

Apply the versioned migrations in order:

1. `supabase/migrations/202610240001_official_permissions.sql`: enums, four required tables, empty protected record table, private invitation reservations, audit triggers, RLS, explicit grants and self-context RPC.
2. `supabase/migrations/202610240002_official_management.sql`: invitation reservation/provisioning/acceptance and checked administrator management functions.

Do not run `bootstrap-first-admin.sql` as a migration. Do not apply these files repeatedly to an existing schema by hand. Use the migration history and create a new migration for future changes. Back up an existing project and review naming conflicts first. No migration modifies the ML directory or imports model/data files.

Keep only `public` in the relevant exposed application schemas; **do not expose `private` or `auth`** through PostgREST. Verify table grants and RLS with the project security advisor. Existing unrelated tables in a project are not secured by these migrations.

Create an ignored `supabase/.env.local` containing only the two custom Edge secrets above, then:

```bash
npx supabase secrets set --env-file supabase/.env.local
npx supabase functions deploy invite-official
```

Retain `verify_jwt = true` in the function configuration; do not deploy with `--no-verify-jwt`. The function additionally verifies the user through Auth and checks live DB permissions. If your project's signing-key configuration needs gateway changes, review the official Edge authentication guidance and test token validation rather than disabling verification as a workaround.

For an isolated local Supabase environment with Docker and the CLI installed, `npx supabase start` runs the local stack and applies the local configuration. Configure Vite and function serving with that stack's **local** values; never use production keys for local tests. The CLI/local Auth stack was not available/run in this implementation, so this path still needs integration verification.

## 4. Manually bootstrap the first administrator

This process requires the trusted project operator's service key and SQL Editor/database-owner access. An ordinary browser user cannot invoke it. Verify the intended person and approval **outside the application** first; an email address does not verify an official identity.

1. Finish Auth settings, redirect/email template, migrations and frontend configuration first.
2. Copy `supabase/bootstrap.env.example` to ignored `supabase/bootstrap.env.local` on the trusted operator workstation, outside any published assets. Supply:

   ```dotenv
   SUPABASE_URL=
   SUPABASE_SERVICE_ROLE_KEY=
   BOOTSTRAP_ADMIN_EMAIL=
   SITE_URL=http://127.0.0.1:5173
   OFFICIAL_INVITE_REDIRECT_URL=
   ```

   Use a project-owner-approved, controlled test mailbox in the test environment. Labels in this repo use `demo.*@example.invalid`; these are non-deliverable examples, not credentials. Never paste actual values into tracked files, command-line arguments or chat logs.

3. Run from `frontend/`:

   ```bash
   node --env-file=supabase/bootstrap.env.local supabase/scripts/invite-first-admin.mjs --check
   node --env-file=supabase/bootstrap.env.local supabase/scripts/invite-first-admin.mjs
   ```

   `--check` validates local configuration format without constructing a Supabase client or making requests. The second command is a live operation: it uses `inviteUserByEmail` with the explicit redirect, refuses an existing administrator and prints only the newly invited **Auth UUID**. It does not print a token or invitation URL.

4. **Before opening the email link**, copy that UUID into the `first_admin_id` variable of `supabase/bootstrap-first-admin.sql` and run the reviewed SQL as project owner in Supabase SQL Editor. It refuses an existing administrator and requires a fresh, unaccepted Auth invitation. It creates an **invited** administrator with zero district record assignments and appends an explicit bootstrap audit entry. It does not create a reusable/public bootstrap function.
5. The recipient opens the email link within one hour, chooses their own password, accepts, then signs in. Supabase verifies the email token; the database refuses activation until the Auth identity has confirmed email and a password. Only then can `/official/admin` be used.
6. Remove the temporary local bootstrap secret file securely according to workstation policy. Keep keys in the project's secret manager. Invite a second approved administrator through the normal interface. Account changes, including assigning districts to the first administrator, must be made by another active administrator.

If the bootstrap recipient opens the email before step 4, the token may be consumed while no profile exists. Do not grant arbitrary accounts roles to “fix” it. Follow the failed-invitation reconciliation below. Disaster recovery after all admins are disabled/deleted is a separately reviewed DBA operation, not a public bootstrap endpoint.

## Invitation failures, expiry and reconciliation

Auth email delivery and PostgreSQL provisioning are separate operations; they cannot share an atomic transaction. The Edge Function reserves and audits the request first, sends the invite, then provisions an **invited** profile/role/scope atomically. No official access is granted before acceptance. If the administrator loses authority during delivery, finalization fails closed. If verification occurs just before provisioning completes, the recipient can retry on the same page once provisioning is complete.

On failure, the function returns a generic error, marks the reservation failed where possible and never returns/logs raw Auth errors or full links. A network/process failure can leave a pending reservation or an Auth-only orphan identity. The administrator UI does not claim success in these cases. The project operator must compare `private.official_invitation_requests`, `audit_logs`, Auth users and `official_profiles` using trusted tooling. Do not “retry” by assigning roles to an existing identity solely because its email matches.

No public resend/delete flow is provided. For the specific **local** case of one expired, unconfirmed first-admin invitation and no official profiles/roles, follow [LOCAL_ADMIN_RECOVERY.md](./LOCAL_ADMIN_RECOVERY.md): the trusted Auth invite API can refresh that same unconfirmed identity without deleting it. The procedure requires explicit approval for the Auth write and bootstrap SQL, and verifies the pending administrator before password setup. Do not delete/recreate a user as an automatic retry, and never manually extend timestamps to bypass expiry. Other failed/accepted account states need a separately reviewed operator procedure. For an accepted user who lost their password, use an approved Supabase recovery process; password recovery UI is outside this milestone. For an expired, missing or replayed token, the portal denies acceptance and directs the recipient to their administrator.

## 5. Test plan

Run repeatable local checks from `frontend/`:

```bash
npm ci
npm run typecheck
npm run build
npm run test:permissions
npm run check:edge        # Deno required; does not deploy anything
npm run test:edge         # Offline test doubles; network and environment access denied
npm run test:bootstrap    # Pure local URL/key-shape validation, no Auth requests
npm run test:public-env   # Negative Vite config probes and browser source/build scan
npm run preview
```

In a second terminal, with preview on port 4173:

```bash
QA_BASE_URL=http://127.0.0.1:4173 npm run verify:browser
```

The portal browser smoke check expects **unconfigured** Supabase. If `.env.local` contains real public settings, leave it unchanged and use a separate test build/preview:

```bash
VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY= npm exec vite -- build --outDir qa-results/unconfigured-dist
npm run preview -- --port 4174 --outDir qa-results/unconfigured-dist
# In another terminal:
QA_BASE_URL=http://127.0.0.1:4174 npm run test:portal-browser
```

This verifies disabled sign-in/no fake authentication, missing-invite handling, guest redirects, initial and same-document token-fragment scrubbing, no external Auth requests, accessibility and responsive layouts. PostgreSQL tests use synthetic demo records only in memory and cover grants/RLS even when client route guards are bypassed. They do not contact a hosted database, apply project migrations or seed production data.

Before allowing officials onto a live project, use separate controlled test mailboxes/browser profiles for the following. Keep fixtures clearly labeled **DEMO ONLY**, never use real incident/official data in a test project, and do not log credentials or bearer tokens.

| Test identity / scenario | Required result |
| --- | --- |
| Public guest | All public pages remain accessible; dashboard/admin redirect to login; direct protected table access with only a public key is denied; no signup route/form exists. |
| Demo district officer, Pune only | Follow an administrator-issued email, set own password, sign in; dashboard returns only Pune records. A direct API query for Raigad/Satara/Ratnagiri returns no rows. `/official/admin` is denied; direct invitation/management RPC calls are rejected. |
| Demo senior officer, Raigad + Satara | Both assigned districts are visible, Pune/Ratnagiri are not; administrative actions and audit reads remain denied. |
| Demo administrator, no districts | Can invite, review/manage other accounts and read audits. Cannot read district records without assignments or change their own role/status/districts. Another active admin can change their assignments. |
| Uninvited Auth user / forged metadata | Even with a valid Auth session, government-looking email or user metadata claiming `system_admin`, no official data or administration is available. Public signup must be disabled in Auth, not merely absent in the UI. |
| Inactive official with an existing token | Keep the old JWT/session, deactivate using a second admin, then repeat the direct REST record query, invitation RPC and audit query. Data access must fail immediately without token refresh. Returning focus to the tab rechecks UI access. |
| Role/district revocation | With an old JWT, move Pune scope to Raigad, remove a role, or demote an admin. Subsequent queries/functions use only the new database authorization. Previously downloaded data cannot be recalled. |
| Invitation lifecycle | No-password/unconfirmed/inactive/expired profile cannot activate. Test fresh, expired, consumed, malformed and missing links, wrong `type`, delivery failure, a preexisting Auth email, partial provisioning, and admin revocation between reservation/finalization. No wrong-identity role assignment occurs. |
| Direct writes / replay / management | As every application role, direct INSERT/UPDATE/DELETE on permission and audit tables fails. Calling the service-only finish/fail RPCs with an end-user token fails. Role upgrades/self-management fail even if UI controls are bypassed. |
| Audit review | Approved invitations, acceptance, scope/status/role changes and bootstrap have durable audit entries; no passwords, password hashes, tokens or full email links appear in application logs. Provider infrastructure logs must also follow this policy. |
| Session behavior | Verify wrong-password errors are generic, Auth/network failures show recoverable states, session refresh/cross-tab sign-out work, logout clears the UI, and invalid JWTs fail at the Edge and database boundaries. |

For district data tests, insert synthetic `DEMO ONLY` rows into `official_records` using a trusted test-project operator connection for all four districts. Do not give application users INSERT permissions for fixtures. Remove test fixtures after verification through trusted tooling.

**Recommend MFA for privileged accounts**, especially system administrators. Supabase supports MFA; this first milestone does not implement factor enrollment/challenge or require AAL2. Before privileged production use, add and verify an MFA challenge flow plus server/database AAL2 enforcement; enabling a dashboard checkbox alone is not an application MFA flow. Keep Supabase project-owner accounts protected by MFA as well.

## Files created and changed

Created:

- `.env.example`, `OFFICIAL_PORTAL.md`.
- `src/official/{types.ts,supabase.ts,AuthProvider.tsx,OfficialPortal.tsx,Dashboard.tsx,AdminPage.tsx,official.css}`.
- `supabase/config.toml`, `supabase/.env.example`, `supabase/bootstrap-first-admin.sql`.
- `supabase/migrations/202610240001_official_permissions.sql`, `202610240002_official_management.sql`.
- `supabase/functions/invite-official/index.ts`, `supabase/templates/invite.html`, `supabase/scripts/invite-first-admin.mjs`.
- `scripts/verify-permissions.mjs`, `scripts/verify-portal.mjs`.

Changed: `src/App.tsx` (link, lazy route, page titles), `src/styles.css` (navigation room at medium desktop widths only), `index.html` (referrer policy), `package.json`/`package-lock.json` (Supabase SDK and isolated PostgreSQL test tool/scripts), `.gitignore`, `README.md`.

No ML files, model weights, GeoTIFFs, Git commits or Git history were modified. `dist/` and local QA screenshots are generated/ignored artifacts.

## Primary references

- [Supabase RLS and metadata caveats](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Admin invitations](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail), [email template variables](https://supabase.com/docs/guides/auth/auth-email-templates), [redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls)
- [Edge Function authentication](https://supabase.com/docs/guides/functions/auth), [server secrets](https://supabase.com/docs/guides/functions/secrets)
- [Database migration workflow](https://supabase.com/docs/guides/deployment/database-migrations), [MFA](https://supabase.com/docs/guides/auth/auth-mfa)

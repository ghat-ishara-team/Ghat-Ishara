# Local first-administrator recovery

Scope is **only** `http://127.0.0.1:54321`. No hosted operation, Auth write, invitation, deletion or SQL write has been executed during preparation. Read-only local diagnostics confirmed:

- One invited Auth user; email unconfirmed; no password set.
- No invitation inside the one-hour bootstrap window.
- Zero official profiles and zero application role assignments.
- Browser and bootstrap configuration both target the local API.
- The running local Auth image is **v2.197.0**; database and mail UI are published at ports **54322** and **54324**.

## Cause and minimal recovery

The invitation acceptance page cannot create the first official profile. Owner-run bootstrap SQL must create the **pending** profile and `system_admin` role before password setup. The expired invitation cannot satisfy the existing freshness guard. The checked-in SQL also contained the invalid literal `YOUR_INVITED_USER_UUID`; its safe `null` default has been restored. No expiry, role or RLS condition was relaxed.

**No Auth user deletion is necessary.** In the installed Auth version, the administrator invite endpoint supports the existing **unconfirmed** user and sends a new invitation for the same identity. It refreshes the confirmation-token state, `invited_at` and confirmation-send timestamp. This is the minimal necessary **Auth write** to recover the same account, so it requires approval. It does not manually extend the database's window, confirm the email, set a password, change the UUID or grant an application role.

Evidence: [v2.197.0 invitation handler](https://raw.githubusercontent.com/supabase/auth/v2.197.0/internal/api/invite.go), [v2.197.0 invitation sending](https://raw.githubusercontent.com/supabase/auth/v2.197.0/internal/api/mail.go). If your local version rejects a re-invitation or the identity/state changes, stop; no deletion, timestamp-edit or database-reset fallback is authorized.

## Prepared, private recovery plan

`supabase/scripts/recover-first-admin-local.mjs` has three modes:

- `--inspect`: GET/HEAD only, with boolean/count output; never emits personal identifiers.
- `--prepare`: GET/HEAD only, then prepares private files; executes no SQL.
- `--invite`: explicit local Auth write, permitted only to POST `/auth/v1/invite` after checking the original unconfirmed recipient, zero profiles/roles and the prepared UUID binding.

All modes refuse hosted targets and HTTP redirects. The script has no SQL-execution, deletion, password-setting or email-confirmation operation. Provider errors are suppressed from public console output.

Preparation has already created **ignored private files**:

- `supabase/.local-recovery/plan.json` — original UUID binding, no credentials/tokens.
- `supabase/.local-recovery/bootstrap.sql` — unchanged bootstrap rules with the UUID substituted privately.
- `supabase/.local-recovery/verify.sql` — read-only checks that the pending administrator is correctly provisioned and ready for password setup.

The directory is mode `0700`; files and the server-only `supabase/bootstrap.env.local` are `0600` (its contents were not changed). Vite also blocks the server-only `supabase/` directory from development HTTP serving. Restart any already-running Vite process so this configuration applies. Do not print/share file contents, open them in a public screen share, or put them in Git. The service key remains only in your existing ignored `supabase/bootstrap.env.local`.

## Exact recovery sequence

Steps 3–4 below require explicit approval before the assistant executes them. They are supplied for review; neither has been run.

1. **Do not open any invitation yet.** Close the old acceptance page and use a fresh private browser session later. Keep only the newest email. Do not manually edit Auth timestamps, confirm the email, set passwords through SQL, reset the database or delete the user.

2. From the frontend directory, optionally repeat the **read-only** inspection:

   ```bash
   cd /home/jack_1213/GHAT_ISHARA_ML/frontend
   node --env-file=supabase/bootstrap.env.local supabase/scripts/recover-first-admin-local.mjs --inspect
   ```

   Expected current results: local target and original recipient match; unconfirmed invitation; `invitationWithinOneHour: false`; zero profiles/roles; `mutationsPerformed: false`. The private plan has already been prepared. For a new independently reviewed recovery plan only, `--prepare` creates those files and refuses to overwrite existing files.

3. **After approving the local re-invitation**, run:

   ```bash
   node --env-file=supabase/bootstrap.env.local supabase/scripts/recover-first-admin-local.mjs --invite
   ```

   Expected safe output: a fresh local invitation was issued for the **same** Auth identity. No UUID or token is displayed. This changes Auth invitation metadata and queues email in local Mailpit. Do not open it yet. If the command reports failure or an unexpected identity/state, stop and repeat read-only diagnostics; do not blindly retry or delete anything.

4. **After approving bootstrap SQL writes**, run these two commands, in this order, from `frontend/`. They explicitly use the local Docker socket and the already verified local database container, ignoring any remote Docker context. No database password or UUID is included in command-line arguments:

   ```bash
   docker --host unix:///var/run/docker.sock exec -i supabase_db_ghat-ishara-official-portal \
     psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=terse \
     < supabase/.local-recovery/bootstrap.sql

   docker --host unix:///var/run/docker.sock exec -i supabase_db_ghat-ishara-official-portal \
     psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=terse \
     < supabase/.local-recovery/verify.sql
   ```

   The first command inserts the pending administrator profile, role and audit entries in one transaction. It preserves the one-hour requirement, refuses any existing administrator, and requires an unaccepted, passwordless, unbanned identity. It creates no district assignments. The second command is **read-only** and outputs only `READY_FOR_PASSWORD_SETUP` if the exact private identity has the pending profile, administrator role, matching fresh timestamps, no password, no email confirmation and no district scope. **Do not proceed unless this verification succeeds.** Error verbosity is terse to suppress identifier-bearing details.

5. Only after verification, start/keep the existing frontend running:

   ```bash
   npm run dev
   ```

   Open local Mailpit at `http://127.0.0.1:54324` privately and open only the **newest** invitation. Its destination must be `http://127.0.0.1:5173/official/accept-invite` with the custom `token_hash` fragment. Do not paste or screenshot the complete link. The page scrubs the fragment and verifies it only when you submit the new password. Complete setup within one hour, then sign in at `/official/login` and check `/official/admin`.

6. Stop if a link is expired, already consumed, or the account state differs. This procedure never relaxes acceptance rules. An accepted active administrator with zero districts can manage invitations but has no district records; this is expected.

## Non-destructive checks performed

The aggregate database diagnostic used `BEGIN READ ONLY` and `ROLLBACK` and printed counts only. The local API inspector used only GET/HEAD and confirmed the configured recipient privately. Runtime Auth configuration was inspected with boolean-only output: custom template configured, local Site URL/redirect matched and OTP expiry is one hour. The generated read-only verification was run against the current state and correctly refused readiness while the profile/role are absent. `npm run test:local-recovery` passed pure offline guard/template tests; `node --check` checks JavaScript syntax without invoking the scripts. TypeScript checks passed. Four local HEAD tests confirmed server-only paths return HTTP 403 (including raw and filesystem-style URLs) while the public page is available; no response contents were read. No local database write was used to test the generated SQL.

Approval still needed: **(a)** refresh the same local user's invitation through the Auth API, **(b)** execute the prepared local bootstrap SQL. No destructive operation is proposed.

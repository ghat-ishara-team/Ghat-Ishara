# First invited demo official login

If the local first invitation expired before a profile existed, use [LOCAL_ADMIN_RECOVERY.md](./LOCAL_ADMIN_RECOVERY.md) instead. It preserves the existing unconfirmed Auth identity and keeps UUIDs out of console output; do not delete the user as an automatic retry.

Local inspection found all migration files, Edge Function imports and the custom invitation flow present. The bootstrap CLI now validates its server-only configuration before any requests and supports `--check` for local-only validation. The existing frontend layout, public routes and ML files are unchanged.

The steps below are instructions for the project owner. **No live Supabase operation has been executed by the assistant.** Keep `.env.local` unchanged; never send credentials or invitation links in chat. Use Node 22.12+ and run terminal commands from `frontend/`.

1. **Set the invitation email template — Dashboard access required.** In Authentication → Email Templates/Emails → **Invite user**, replace the body with `supabase/templates/invite.html`. It must link to `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=invite`. Confirm email OTP expiry is **3600 seconds**, password minimum is **12**, and public signup remains disabled. Confirm SMTP can send to your controlled test mailboxes (the default mail service may restrict recipients). For this local demo, use `http://127.0.0.1:5173` consistently and confirm the exact allowed redirect is `http://127.0.0.1:5173/official/accept-invite`. Applying SQL does not update hosted email settings.

2. **Apply the pending migrations — Supabase account/CLI authentication and project database access required.** Find the project reference in Project Settings → General. Authenticate interactively; never put access tokens or database passwords on the command line.

   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase migration list --linked
   npx supabase db push --linked --dry-run
   npx supabase db push --linked
   ```

   Review the target and dry-run first: on the intended fresh database it should show `202610240001_official_permissions.sql` then `202610240002_official_management.sql`. If either version was previously applied with older contents, use a forward migration instead of rerunning/resetting it. No seed flag or bootstrap SQL is part of this step.

3. **Set function settings and deploy — Supabase CLI/project deployment access required.** The example below contains only the two non-secret URL settings. Match them to step 1, then deploy:

   ```bash
   cp supabase/.env.example supabase/.env.local
   npx supabase secrets set --env-file supabase/.env.local --project-ref YOUR_PROJECT_REF
   npx supabase functions deploy invite-official --project-ref YOUR_PROJECT_REF
   ```

   Keep `verify_jwt = true`. Supabase supplies the function's `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`; these do not belong in Vite variables or the custom secrets file. The handler additionally verifies the user with Auth and checks the active database administrator before sending any invitation. Current [Supabase header guidance](https://supabase.com/docs/guides/functions/auth-headers) supports both legacy and asymmetric user JWTs with the gateway check enabled.

4. **Invite and provision the first administrator — server key and SQL Editor owner access required.** Do this before any other ordinary user invitations. Create a separate, ignored private file:

   ```bash
   cp supabase/bootstrap.env.example supabase/bootstrap.env.local
   ```

   Fill it in a local editor: project URL; server-only legacy `service_role` key (Project Settings → API Keys → Legacy anon/service_role) or a suitable server secret key; your controlled administrator mailbox; and the matching site/redirect URLs. This file is separate from the existing browser `.env.local` and the Edge URL settings file. Do not print it, put its values in `VITE_` variables or pass credentials as shell arguments.

   ```bash
   node --env-file=supabase/bootstrap.env.local supabase/scripts/invite-first-admin.mjs --check
   node --env-file=supabase/bootstrap.env.local supabase/scripts/invite-first-admin.mjs
   ```

   The first command checks local format only, not credential validity. **The second command contacts Supabase and sends the first email.** It prints only the invited Auth UUID. Before opening that email, copy `supabase/bootstrap-first-admin.sql` into Dashboard → SQL Editor, replace `first_admin_id uuid := null;` with `first_admin_id uuid := 'THE_PRINTED_UUID'::uuid;`, and run it as project owner. It creates a pending administrator with no district records, refuses an existing admin, and grants no access until acceptance. No password is entered in SQL. Keep the private bootstrap file in trusted storage or remove it under your workstation's secret-handling policy after use.

5. **Accept the administrator invitation — recipient mailbox access required.** Start the existing website:

   ```bash
   npm run dev
   ```

   On the development machine, open the invitation email within one hour, set a unique password of at least 12 characters, then sign in at `http://127.0.0.1:5173/official/login`. Open `/official/admin`. This administrator initially has zero district record assignments, which is intentional.

6. **Create the demo official through the portal — signed-in active administrator and another controlled mailbox required.** Invite that mailbox as `district_officer`, with **Pune** selected. Use a private/separate browser session for the recipient, accept the email, set their own password, then sign in at `/official/login`. The dashboard should show Pune and district-officer access; `/official/admin` must be denied. An empty authorized-record list is expected until records are imported. No fictitious operational data or working demo credentials are provided.

7. **Confirm the boundaries — controlled test-project access required for live verification.** Local PostgreSQL tests already verify Pune-only officer scope, multi-district senior scope, no implicit administrator record access, revoked/inactive/banned restrictions and blocked self-management. With actual issued sessions, repeat the role matrix in `OFFICIAL_PORTAL.md` before relying on the deployment. Real email delivery, token expiry/replay and hosted RLS/Edge behavior have not been exercised by the assistant. MFA is recommended for administrators; no MFA enforcement is claimed here.

To repeat the offline checks without contacting the project:

```bash
npm run build
npm run check:edge
npm run test:permissions
npm run test:edge
npm run test:bootstrap
npm run test:public-env
```

The PostgreSQL tests use a disposable in-memory Auth schema stub. Edge tests deny network/environment access and use explicit doubles. For browser checks that make no Auth requests, use the blank-configuration test build described in `OFFICIAL_PORTAL.md`; do not replace your real frontend `.env.local`.

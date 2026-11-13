# Stage 1 officer access requests

Stage 1 adds `/official/request-access` and `/official/verify-request`. It collects name, official email, department, designation, requested districts and reason. The login page links to the form. It does not implement an administrator review queue, approve/reject actions or approval-triggered invitations. Existing administrator-issued invitations, login, acceptance and district permissions remain separate and unchanged.

## Storage and verification

The forward migration `supabase/migrations/202611010001_official_access_requests.sql` creates `private.official_access_requests` and `private.official_access_request_limits`. No existing migration is edited. No migration has been applied to the existing local or hosted database by this implementation.

Applications start `pending`, with `email_verified_at` unset. Applicant-requested districts are separate from the reserved approved role/district fields. Reviewer fields, decision notes, invitation reservation and Auth-user links are reserved for later stages; no Stage 1 API can set them. A partial index identifies pending, email-verified applications for a future review queue. Approval constraints require verified email and review metadata, but Stage 1 exposes no approval operation.

The submission function creates a cryptographically random 256-bit verification token. Only its SHA-256 is stored. The raw capability exists in the local verification email and briefly in process/browser memory; it is never stored in SQL or browser storage, logged, or returned by the submission endpoint. Links use `/official/verify-request#token=…`; the page immediately removes the fragment/query and requires an explicit **Confirm email** action. GET/link preview does not verify a request. Refreshing after fragment removal requires reopening the email link.

Verification has a 20-minute deadline and is single-use: a successful atomic update sets `email_verified_at` and clears the hash. Status remains `pending`; no Auth user, profile, invitation, role or district permission is created. Mailbox ownership is not proof of government employment. Later administrator review must independently establish identity and authority.

## Security and limits

- RLS is enabled with no client allow policies. Direct table privileges are revoked from `anon`, `authenticated` and `service_role`. Only two narrowly scoped service-role RPCs accept submissions and consume verification hashes; clients cannot execute them directly. Functions use a fixed empty search path.
- The two new Edge endpoints are intentionally public (`verify_jwt = false` for those endpoints only). Existing `invite-official` retains `verify_jwt = true` and its live administrator checks. A browser public key is not authorization for private database access.
- Server and SQL validation constrain fields, reject role/status/verification overrides, bound string lengths and validate one to four distinct supported districts. HTTP bodies are capped at 8 KiB while streaming, with a five-second read limit. Application form drafts are not persisted in browser storage.
- Persistent fixed-window budgets allow at most three valid submission attempts per normalized email per hour, 100 globally per hour and 1,000 globally per day. Duplicate attempts count. Verification is capped at 1,000 well-formed-token attempts globally per hour. Limits are serialized in SQL; restarting an Edge worker does not clear them. Old budget rows are pruned after two days. Email budget keys contain SHA-256 hashes, which are not a guarantee of anonymization.
- Valid submissions return the same HTTP 202 acknowledgement for new, duplicate and rate-limited applications. Auth account existence is not queried. Verification of well-formed tokens returns the same message for success, expiry, unknown tokens and replay. Malformed input returns a generic 400; service misconfiguration/storage failure returns a generic 503. No application IDs, private records or provider errors are returned.
- An unexpired duplicate does not modify claims, rotate the capability or send another message. A pending unverified application with an expired challenge can be updated and issued a new token within budgets. Verified applications are not modified by anonymous resubmission.
- Email capture runs through `EdgeRuntime.waitUntil`, outside the acknowledgement path. Transport failures do not expose per-email state. There is no durable mail retry worker in Stage 1: if delivery fails or the worker stops, retry after the 20-minute challenge expires, subject to the hourly attempt budget. Do not blindly retry repeatedly.
- The mail adapter is explicitly for local Mailpit HTTP capture, with server-configured local targets, no credentials in its URL, no redirects and a five-second timeout. It does not send production mail. Missing configuration disables these endpoints. A hosted mail adapter, production abuse controls and personal-data retention policy require review before hosted use; they are not enabled here. Global budgets bound email/storage abuse but can be exhausted by an attacker, so they do not replace gateway-level anti-abuse controls.

## Automated tests without Docker

From `frontend/`, after `npm ci` and map setup:

```bash
npm run test:access-requests
npm run test:permissions
npm run test:edge
npm run typecheck
npm run build
deno check --node-modules-dir=manual supabase/functions/submit-access-request/index.ts supabase/functions/verify-access-request/index.ts
```

`test:access-requests` executes all three real migrations in a disposable in-memory PostgreSQL instance (PGlite), using a test-only Auth schema. It connects handler RPCs to this database and doubles email transport. It tests input validation, duplicates, persistent budgets, bounded bodies, token expiry/replay/reissue, private grants/RLS, generic responses, and absence of official permissions. It does not prove Docker networking, real PostgREST/gateway behavior, Mailpit compatibility or actual browser accessibility.

## Exact isolated local acceptance procedure

Use a recent Supabase CLI with Mailpit-backed local mail capture and Docker. Do not run database reset, link, push or deploy commands. Do not change the existing project's config, environment files or volumes.

1. From `frontend/`, prepare source copies and a distinct local configuration:

   ```bash
   npm run prepare:access-requests-local
   cd qa-results/stage1-local
   npx supabase start
   ```

   Preparation refuses an existing destination. It copies only migrations/functions/templates/public shared validation, sets project ID `ghat-ishara-stage1-test`, and uses API **65421**, DB **65422**, Studio **65423**, mail UI **65424**, mail SMTP **65425**, mail POP3 **65426**, Edge inspector **65427** and frontend **5178**. Start applies migrations to this new local stack only. If ports conflict, stop and select reviewed nonconflicting ports in this isolated copy. Never reset the existing database to resolve a conflict. CLI output can contain local server credentials; inspect privately and do not paste it into reports.

2. In that isolated project, serve functions:

   ```bash
   npx supabase functions serve --env-file supabase/.env.local
   ```

   The generated server file contains only the local Site URL, invitation redirect and local Mailpit URL. CLI serving supplies the isolated stack's Supabase runtime credentials; never copy production credentials. Do not use a blanket `--no-verify-jwt` flag. Per-function configuration makes only the two Stage 1 endpoints public.

   The adapter targets `http://supabase_inbucket_ghat-ishara-stage1-test:8025/api/v1/send` from the Edge network. Confirm the isolated CLI actually uses Mailpit and exposes this API internally; older Inbucket images are not compatible. If capture is unavailable, stop and correct only this isolated stack's local capture adapter/configuration. Do not fall back to a hosted email service.

3. Privately inspect the isolated stack's `npx supabase status`. In a local editor, create `frontend/qa-results/stage1-browser.env.local` containing only:

   ```dotenv
   VITE_SUPABASE_URL=http://127.0.0.1:65421
   VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_ISOLATED_STACK_PUBLIC_PUBLISHABLE_OR_ANON_KEY
   ```

   Replace the placeholder with that stack's public key. Preserve the existing `frontend/.env.local`. In another terminal, from `frontend/`, run:

   ```bash
   node --env-file=qa-results/stage1-browser.env.local node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5178 --strictPort
   ```

4. Open `http://127.0.0.1:5178/official/request-access`. Submit synthetic information and select Pune. Confirm accessible validation, loading state and generic acknowledgement. Inspect the verification message privately in `http://127.0.0.1:65424`; never copy the full link/token into logs or screenshots. Open it, verify that the URL fragment disappears, then press **Confirm email**. Do not use real applicant data for acceptance tests.

5. With the isolated stack's owner tooling, inspect only aggregate counts/boolean state: one pending application, verified timestamp set, verification hash cleared, and no new Auth user, official profile, role, district assignment or invitation. Anonymous and authenticated direct application reads/writes and client calls to the service-only RPCs must fail. A synthetic authenticated identity without an active official profile must see no protected records even with a direct REST call. Never print application rows or use server credentials in the browser.

6. Repeat with a duplicate, a fourth submission attempt within the hour, an expired link, a replayed link and unsupported/oversized input. Each well-formed submission still receives the generic acknowledgement; no extra permissions are created. For expiry, wait 20 minutes or use only disposable fixtures in the isolated test database; never modify the working local database or relax production expiry rules.

7. Stop only this stack from `frontend/qa-results/stage1-local` using `npx supabase stop` when done. No reset or volume deletion is required. Keep private test files ignored.

## Browser regression checks with synthetic configuration

These tests contact no real Supabase project. Build and serve the explicit synthetic configuration from `frontend/`:

```bash
VITE_SUPABASE_URL=https://stage1-fixture.example.invalid VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_DEMO_ONLY_NOT_A_REAL_KEY npm exec vite -- build --outDir qa-results/stage1-configured-dist
npm exec vite -- preview --host 127.0.0.1 --port 4187 --strictPort --outDir qa-results/stage1-configured-dist
```

In another terminal:

```bash
QA_BASE_URL=http://127.0.0.1:4187 npm run test:access-requests-browser
```

The browser test intercepts all external requests and uses synthetic submission/verification responses. It checks validation/focus, disabled loading states, no role selection, no persisted applicant draft, fragment scrubbing, explicit confirmation, responsive layouts and automated accessibility. Use the separate blank-config build from `OFFICIAL_PORTAL.md` for `test:portal-browser`; that existing check now includes both new routes. Browser tests require Chromium and permission to bind a local preview server.

# Pre-migration authentication review

Review scope: repository code and offline verification only. No Supabase project database connection, migration application, real user creation, invitation delivery or sign-in was performed. No ML, website design, public routing or Git history changes were made. Synthetic PostgreSQL fixtures exist only inside the disposable in-memory test process.

## Findings fixed before migration application

1. **Auth ban/soft-deletion gap (security hardening).** Application inactivation already revoked data access, but the old RLS role lookup did not independently check Auth bans, deleted identities or confirmed-email state when using an existing JWT. A shared, non-client-executable `private.official_role_for(uuid)` now checks both application and Auth state. RLS and invitation finalization share it; acceptance and manual bootstrap also reject banned/deleted identities. Tests keep the same subject before/after state changes.
2. **Build-time secret exposure risk.** The old runtime public-key validator could reject a pasted service key only after Vite had embedded it. `vite.config.ts` now rejects recognizable secret keys, service-role JWTs and obvious server-secret variable names under `VITE_` before transformation, with no value disclosure. Four negative build probes verify this. No recognized secret/service-role literals were found in browser source or the current build. Public URL/publishable-key settings are present in `.env.local`, which is ignored and unchanged; publishable keys are intentionally public. This scan is not a guarantee against arbitrary encoded secrets or exposures in earlier/deployed builds. [Vite’s exposure rules](https://vite.dev/guide/env-and-mode).
3. **Invitation fragment captured only once (functional/sensitive-URL handling).** An invitation arriving as a same-document hash navigation after portal module initialization could remain unscrubbed until reload. The acceptance page now captures/scrubs each invitation navigation before paint. The browser regression asserts this without reloading first. Tokens remain in memory only, not application logs or persistent custom storage.
4. **Redirect/cleanup robustness.** The localhost development exception previously accepted other URI schemes for localhost; it now allows only HTTP loopback or HTTPS. Failed invitation cleanup is also caught so provider errors cannot escape through an unhandled failure. Invalid bodies fail before authorization/email. The deployable `index.ts` now wires a separately testable production handler, with the privileged client created only after administrator authorization.
5. **Inherited grants and SQL NULL handling.** The audit identity sequence now has explicit revokes to counter broad Supabase default sequence grants. Invitation finalization rejects missing/mismatched email and missing/old creation timestamps using fail-closed checks. Expanded tests run with broad table/function/sequence defaults, not just bare PostgreSQL defaults.

The two pending migration files were corrected in place because this review precedes their application. If a different target has already applied either version, do not replay/reset it: prepare a reviewed forward migration instead. This review did not inspect any target's migration history.

## Requested verification

| Item | Repository/offline result | Still needs project verification |
| --- | --- | --- |
| 1. Invitation Edge Function | `supabase/functions/invite-official/index.ts` exists. The handler verifies the bearer with Auth, calls `begin_official_invitation` with the caller's JWT, and sends only after that RPC confirms a live system administrator. Service-only finalization rechecks the actor, reservation and identity. Offline tests assert call order and zero sends for denied callers. | Deployed function version, gateway JWT/signing-key compatibility, project secrets and actual Auth verification. |
| 2. Email template/redirect/token flow | Template uses `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=invite`. Client accepts `type=invite`, calls `verifyOtp`, then password update and acceptance RPC. Local allow list contains the exact 5173/4173 `/official/accept-invite` paths; server custom secrets select one exact origin/path. Password submission, not page viewing, consumes a token. | Hosted template contents, Site URL, allow list, SMTP/link tracking and actual one-hour, one-use token behavior. CLI config does not configure hosted Auth by applying SQL. |
| 3. Migration order/fresh schema | The `001` then `002` SQL definitions pass in disposable PostgreSQL with a minimal Supabase Auth schema/UID test stub and broad Supabase-style default grants. Function/table/type dependencies and application queries execute there. No local SQL syntax/order failure remains in those tests. | Full fresh hosted Supabase execution, database owner privileges, actual Auth schema columns, existing-name conflicts and PostgREST schema cache. No project migration was applied. |
| 4. Escalation/district RLS | Client writes denied even for admins; service-only RPCs cannot be executed by ordinary users; no self-management; no authorization from email or user-editable metadata. Officers/seniors see only assigned districts, admins get no implicit district access. Live DB role/status/scope/Auth state controls access with the same subject. | Hosted REST/RPC behavior using real issued JWTs and concurrent administrative changes. Isolated tests do not test Supabase token signature verification. |
| 5. First admin | Manual trusted CLI plus owner-run SQL; no public bootstrap RPC. Fresh unaccepted invitation UUID required, existing admin prevents rerun, inactive Auth state rejected, zero district scope, audited pending profile, password/email verification required before activation. Ordinary DB-role execution of the bootstrap block is denied in the tests. | Operator identity verification, secure service-key handling and actual bootstrap email/password lifecycle in a test project. |
| 6. Browser secrets | Server/CLI modules are outside browser imports; source/build scan found no recognized private key literals or server-only modules. Build guards reject simulated private-key configurations without printing values. `.env.local` remains ignored and unchanged. | Hosted build environment, previously published artifacts, CI/hosting logs and secret rotation history. |
| 7. Expiry/revocation/inactive access | Expired/unaccepted/revoked profiles cannot activate or read records. Inactivation, role/district removal and Auth ban/deletion block subsequent protected queries with the same subject. Reused acceptance attempts fail. | Actual token expiry/replay, SMTP latency and deployed access-token refresh/sign-out behavior. |

An accepted active official does not lose their account when the **invitation link** later expires; that deadline applies to initial acceptance. Revoke an account through application status/permissions. A revoked invitation may still create/verify an Auth session at the provider, but inactive application status denies official data and activation. No route guard is relied on for data authorization.

## Checks completed

- `npm run build` — includes TypeScript checks; passed.
- `npm run check:edge` — entry point and handler type-check; passed.
- `npm run test:permissions` — **65** checks in disposable PostgreSQL; no hosted/persistent DB involved.
- `npm run test:edge` — **7** offline handler tests, with `--deny-net --deny-env`; calls use explicit test doubles, not real Supabase Auth or email.
- `npm run test:public-env` — **4** rejected private-config build probes plus browser-source/build scanning; values never printed.
- `npm run verify:browser` — existing public routes, map CTA, mobile navigation, reduced motion and automated accessibility checks; passed against production preview.
- `npm run test:portal-browser` — blank-config test build, guest route guards, disabled forms, initial/same-document hash scrubbing, no external requests, eight viewport widths and automated accessibility checks; passed. This test deliberately requires a blank-config build; the regular public configuration correctly enables login inputs.

To repeat the portal smoke test without changing `.env.local`, use the isolated build commands in [OFFICIAL_PORTAL.md](./OFFICIAL_PORTAL.md#5-test-plan). That guide also contains the complete project configuration, migration, bootstrap and live role-by-role test procedures.

## Files changed in this review

- Pending SQL migrations `202610240001_official_permissions.sql`, `202610240002_official_management.sql` and `supabase/bootstrap-first-admin.sql`.
- `supabase/functions/invite-official/index.ts`; added `handler.ts` and `handler.test.ts` alongside it.
- `src/official/supabase.ts`, `src/official/OfficialPortal.tsx` and `vite.config.ts`.
- Expanded `scripts/verify-permissions.mjs`, `scripts/verify-portal.mjs`; added `scripts/verify-public-env.mjs` and package test scripts.
- `OFFICIAL_PORTAL.md` and this report. No dependencies added, no `.env.local` changes, and no website style/layout changes.

Before project rollout, verify the hosted settings above and run the controlled test-project matrix. MFA is still recommended for administrators; MFA enrollment/challenge/AAL2 enforcement and password recovery remain outside this implementation. This is a source/offline review, not a certification of the deployed project.

Primary references: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Edge Auth](https://supabase.com/docs/guides/functions/auth), [email templates](https://supabase.com/docs/guides/auth/auth-email-templates), [Auth user model fields](https://github.com/supabase/auth/blob/master/internal/models/user.go).

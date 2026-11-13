# Local preferences and form drafts

This system saves explicitly approved inputs, not application or authentication state. It makes no requests and never submits a form. Browser storage is plaintext, readable by scripts on the same origin; use a private browser profile on shared devices.

## Existing behavior

- **Administration / invitation:** partial recipient email, requested role and requested districts save immediately in per-tab `sessionStorage`. Restore is synchronous on route return and refresh. A failed invitation retains the draft. A confirmed response containing a user ID, or **Clear Draft**, resets all fields, including the role. A delayed success preserves newer work entered after navigating away and back.
- **Administration / account access:** selected target UUID, an opaque revision fingerprint, and requested role/district/status edits save in `sessionStorage`. No complete account object or account list is stored. Fresh server reads must find the selected target and match its revision before edits appear. Changes to a target's status, roles, districts or revision discard old edits. Self-edits and activation of an unaccepted account are disallowed. Every explicit Save reloads the target before calling the existing server RPC; restoration never invokes that RPC. A successful update clears its draft; a failed update retains it. The fingerprint is a UI conflict detector, not a transactional server lock or authorization mechanism.
- Both drafts expire after **8 hours from the last changed value**. They are scoped by normalized Supabase project URL and authenticated user ID. Same-account focus/token checks preserve drafts; account switches and successful sign-out clear that project's official drafts. A fresh inactive/no-access response clears all official drafts, and loss of administrator role clears administrator drafts. A temporary verification transport error blocks the portal but retains the draft for retry.
- Small live status messages distinguish saved, saving, unavailable and blocked states. Clear Draft changes only local UI storage, never account permissions or sent invitations.
- Dashboard and public pages currently have no editable filters or preferences to attach persistence to. No demonstration controls were added. The dashboard refreshes its records on authorization changes and does not display records outside the current district scope.

The original disappearing-form issue was component-local React state. Route changes and refresh discarded it, and background authentication checks temporarily cleared verified context and rendered the route loading guard, unmounting the form. Verified same-account checks now keep the mounted page while disabling administrative actions; new accounts remain gated until verification finishes.

## Reuse

Declare stable module-level `PersistenceSchema<T>` objects. Each must have a unique ID within its storage kind, a schema version, TTL, default factory, and a parser that validates and **projects only approved fields**. Bump `version` when a stored shape becomes incompatible; old versions are discarded. Do not pass whole forms, records, sessions or auth objects.

```tsx
// An official form: owner comes from the authenticated user, never a cached role.
const { session } = useOfficialAuth()
const owner = session ? officialDraftScope(session.user.id) : null
const { draft, setDraft, clearDraft, status } = useFormDraft(invitationDraftSchema, owner)
// setDraft is automatic local persistence; submit explicitly through the backend.
// Only after confirmed server success: clearDraft()
```

`usePersistentState(schema)` handles public `localStorage` preferences. `useFormDraft(schema, owner)` handles official `sessionStorage` drafts. `DraftControls` provides a status and explicit clearing action. Do not declare schemas inside render or reuse an ID for a different type.

For the future Map Explorer, `mapPreferences.ts` exports `usePublicMapPreferences()` and `useOfficialMapPreferences(owner, latestAuthorizedDistricts)`. Both persist selected district, allowlisted layer IDs, opacity and longitude/latitude/zoom. Public preferences last **30 days** in localStorage and survive browser restart; official preferences last **8 hours** in sessionStorage. Map updates debounce for 200 ms and flush on unmount, hidden-tab transition and pagehide. Official district selections are synchronously revalidated against the supplied fresh authorization list; pass an empty list until access is verified. These hooks do not authorize requests or persist layers' underlying data. Actual map controls are a later milestone.

## Security boundaries and limitations

- Never persist passwords, password confirmation, access/refresh tokens, invitation links, API keys, service-role credentials, official records, audit logs or fetched account profiles. Schema projection is the main boundary; an additional secret-pattern guard rejects recognizable secret-like strings. It cannot identify every possible secret pasted into an approved text field. Login and invitation-password inputs remain ephemeral.
- The Supabase SDK's existing Auth session storage is separate and unchanged. Autosave never reads or copies those credentials. New keys use `ghat-ishara:persist:`. Official keys include project and user identifiers (not credentials); an owner marker permits cleanup after reload. Other applications' keys and SDK session storage are never cleared by this system.
- Cached invitation/management roles and districts are **requested edits**, never the current viewer's permissions. Fresh Supabase context, existing server verification and RLS remain authoritative. There are no migration, authorization-rule, invitation-expiry or server API changes.
- Unavailable or quota-limited storage falls back to editable in-memory values with an honest status. Reload cannot restore values that were never saved. Invalid JSON, incompatible schemas, non-allowlisted envelopes and expired values are discarded. If deletion is denied, Clear Draft resets the in-memory fields and reports local saving unavailable; the browser may retain the previous envelope until it can be deleted or expires. Unchanged updates do not write. Expired in-memory values clear on their expiry timer.
- sessionStorage is per tab. Browsers may copy it when duplicating a tab or retain it through session restoration; it is not a cryptographic privacy boundary and cannot guarantee deletion from a closed browser. The expiry and owner checks still apply. Explicit sign-out is recommended on shared devices.
- Public preferences are origin-wide; existing open tabs do not live-synchronize localStorage changes. They each retain their current view, and newly mounted browser contexts read the saved value.
- The target fingerprint reduces accidental stale edits but cannot eliminate a change occurring between the last read and the existing mutation RPC. Server RLS and administrator checks still enforce authority. No automatic retry, offline mutation queue or automatic invitation delivery is introduced.

## Verification

Run from `frontend/`:

```sh
npm run test:persistence
npm run test:persistence-browser
npm run build
npm run check:edge
npm run test:permissions
npm run test:edge
npm run test:bootstrap
npm run test:public-env
```

The browser suite builds the actual frontend with synthetic configuration, mocks all Supabase transport, and launches Chromium (default `/usr/bin/chromium`; override `CHROMIUM_PATH`). It includes a test-only map-hook entry point under `scripts/fixtures/`, excluded from the production build. It tests navigation, focus DOM preservation, refresh, invitation/update failure and success, draft clearing, fresh account revisions, delayed responses, inactive accounts, verification failures, per-tab isolation, account switching/sign-out, role revocation, malformed/expired storage, excluded secrets, blocked storage, accessibility, mobile overflow, revoked map districts and a real browser process restart for public preferences. Artifacts and synthetic profiles live under ignored `qa-results/`. It performs no real invitations, authentication, migrations or database writes.

The unit suite executes the actual storage/schema modules. The existing PostgreSQL permissions suite exercises migrations and RLS in isolated PGlite; it does not connect to the configured Supabase project. These tests do not certify live email delivery or deployed project behavior.

Manual check with an already authorized demo administrator: start `npm run dev`, type an unsent invitation, visit Dashboard then Administration, switch tabs, refresh and confirm values/indicator. Try Clear Draft, then sign out and confirm no old draft appears on the next login. To test live success/failure or actual role/district revocation, use your approved local/demo Supabase setup and explicit administrative actions; those operations have not been performed by this implementation. Never use real official records or credentials as test input.

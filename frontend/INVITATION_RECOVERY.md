# GHAT ISHARA — Invitation Failure Recovery

## Purpose

This guide describes safe recovery procedures when an approved officer's invitation fails during Supabase Auth delivery or database provisioning.

## Security principles

- Never automatically retry a failed invitation.
- Never delete an Auth account to make an invitation retry succeed.
- Never remove an invitation reservation without investigating its state.
- Never activate an officer account without verified invitation acceptance.
- Never modify approved roles or districts during recovery.
- Never expose invitation links, tokens, service-role keys or passwords in logs.
- Use the isolated test environment for recovery testing before introducing a production procedure.

## Recovery scenarios

### Scenario A — Reservation failed before an Auth account was created

1. Verify the application is approved and its email was verified.
2. Inspect the reservation and audit logs.
3. Confirm no matching Auth account exists.
4. Record the failure and obtain administrator authorization for a new attempt.
5. Use a separately reviewed, audited recovery operation to create a new approval-linked reservation.

Do not manually clear the existing reservation.

### Scenario B — Auth account exists, but provisioning failed

1. Stop automatic retries.
2. Verify the Auth user's identity and email against the approved application.
3. Examine invitation delivery and failure audit events.
4. Determine whether the invitation token has expired.
5. Use a dedicated, audited recovery operation to reconcile the existing Auth identity with the approved permissions.

Do not create another Auth account or directly activate the officer.

### Scenario C — Provisioned invitation expired before acceptance

1. Verify the existing Auth identity, official profile and approved application.
2. Confirm the account has not already been accepted.
3. Issue a fresh invitation through a dedicated recovery procedure.
4. Verify that the same Auth UUID is retained.
5. Synchronize the invitation deadline using a guarded, audited database operation.
6. Require the officer to complete password setup and acceptance.

Do not modify timestamps merely to bypass expiration checks.

## Current implementation limitation

The system currently prevents duplicate invitations by retaining the approval-linked reservation after a failure.

This is intentionally fail-closed, but an automated, audited recovery mechanism has not yet been implemented or tested.

Until such a mechanism exists, failed invitations require operator investigation and should not be retried through the normal administrator interface.

## Production readiness

The happy-path onboarding workflow has been validated in an isolated local environment.

Production readiness additionally requires:

- Automated failure-injection tests.
- Verification of concurrent invitation attempts.
- A reviewed and tested recovery mechanism.
- Full security review of administrator provisioning.
- Deployment configuration and secret-management review.

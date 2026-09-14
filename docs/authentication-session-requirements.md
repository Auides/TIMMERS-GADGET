# Authentication and operational-session requirements

Status: **APPROVED — deferred implementation required before production release.**

## Scope

These requirements apply to operational sessions for `STAFF` and `MANAGER` accounts only. They are not attendance, payroll, HR, commission, lateness, or performance-management functionality.

## Required behaviour

- Record each successful operational sign-in with `signed_in_at`.
- Record explicit sign-out with `signed_out_at`.
- Show the current operational sign-in time in the application.
- Allow `ADMIN` to view immutable Staff/Manager sign-in and sign-out history.
- Require a new operational session each business day. A prior-day session must not grant operational access on the next day.
- Calculate business days in `Africa/Lagos`.
- Expire Staff/Manager operational access after one hour of inactivity and require authentication again.
- Keep explicit end-of-day sign-out as a required workflow.
- Do not treat browser, tab, PWA, or device closure as a reliable logout event.

`ADMIN` retains the existing authentication/session model unless a future approved requirement changes it.

## Planned implementation phase

Implement in the next authentication hardening/session-management phase, before production release. The work will include:

1. A new migration for an append-only operational-session history table, session status/state constraints, `Africa/Lagos` business-date handling, RLS, indexes, and Admin-only history access.
2. Authenticated server/RPC operations to open a Staff/Manager operational session after Supabase Auth sign-in, explicitly close it at sign-out, and record immutable audit metadata.
3. Protected-route/session enforcement that rejects absent, expired, inactive, or previous-business-day Staff/Manager operational sessions while preserving existing Supabase Auth and active-profile checks.
4. UI for current session time, timeout/re-authentication, explicit sign-out, and Admin history viewing.
5. Unit, integration, RLS, timezone-boundary, inactivity, and immutable-history tests.

## Non-goals

This requirement does not authorize payroll, attendance scoring, lateness penalties, commissions, HR records, or any customer-facing time-tracking feature.

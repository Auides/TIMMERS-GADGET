# TIMMERS GADGET

Internal, responsive PWA for stock, sales, purchases, customer credit, returns and financial records.

## Local setup

1. Copy `.env.example` to `.env.local` and add Supabase project values.
2. Do **not** apply the initial migration until the Product Owner approves the Gate 2 review. Once approved, apply `supabase/migrations/202608290001_initial_schema.sql` in the Supabase SQL editor or with the Supabase CLI.
3. Run `npm run dev`.

## Security model

The initial schema enables RLS on every transactional table. Browser users only access data through their active profile; mutations are deliberately denied by default. Critical operations should be exposed through authenticated server-side RPC functions that validate roles, state transitions, idempotency and audit logging in a single database transaction.

Never place Supabase `service_role` credentials in browser-accessible environment variables.

## Approved deferred authentication work

Staff/Manager operational-session history, Africa/Lagos business-day enforcement, and a one-hour inactivity timeout are approved for the authentication hardening phase before production release. See [authentication-session-requirements.md](docs/authentication-session-requirements.md).

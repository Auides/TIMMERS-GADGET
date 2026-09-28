# Recovery baseline

## Scope and safety

This recovery baseline is anchored to commit `6c52ed59c30229ed28dd2d3174ea44bed047b05a` on the `recovery/offline-v2` branch. It is source-control and test-gate work only. Production Supabase project `wugmcqtyiknqobjqwhno` must not be mutated during baseline recovery. Do not run the preserved SQL verification scripts against production as part of this baseline.

This document intentionally contains no secrets, API keys, tokens, passwords, environment values, customer data, or production-backup contents.

## Technology and deployment stack

- Next.js 16, React 19, and TypeScript
- Supabase/PostgreSQL
- Tailwind CSS
- Cloudflare Workers and Vinext

The standard application build is `npm run build` (`next build`). The Cloudflare/Vinext build is `npm run build:vinext` (`vinext build`), which produces the Worker-oriented output used by the existing Wrangler scripts. The Vinext build currently detects `.env.local`; it is deliberately excluded from secret-free GitHub Actions CI until it can be verified without local or production configuration.

## Implemented modules

- Authentication and login
- Product catalogue, variants, and pricing
- Inventory, serialized inventory, opening stock, and inventory adjustments
- Suppliers, purchases/procurement, supplier payments, returns, and refunds
- Ordinary sales/POS, split payments, and camera/manual scanning

## Deferred modules

- Operational session hardening, customers, discount UI, and credit UI
- Returns, customer refund/exchange workflows, expenses, and reporting
- Completed-sale reversal UI/RPC, staff/user management, audit/settings UI
- Complete PWA/offline implementation, PDF reporting, and branding/logo

The future offline-first architecture supersedes the old online-only critical-transaction requirement, but it has not been implemented in this baseline.

## Test and build commands

- `npm ci`
- `npm test`
- `npm run test:catalogue-price`
- `npm run test:inventory`
- `npm run test:sales`
- `npm run lint`
- `npm run build`
- `npm run build:vinext` (local validation only; it currently reads `.env.local`)

`npm test` executes catalogue, inventory, and sales payload tests.

## Current coverage and next gaps

| Area | Current coverage | Important gap |
| --- | --- | --- |
| Catalogue | Price payload shape, activation readiness, safe messages, filters, and navigation state | Server actions, persistence, RLS, and catalogue integration paths |
| Inventory | UI helpers, role capabilities, validation, safe staff context, exact price matching, and source-level safeguards | End-to-end stock changes, concurrent adjustments, opening-stock persistence, and real RPC authorization |
| Sales | Checkout total display, line payload price exclusion, deterministic serialized-unit sorting, and payment normalization | Sale finalization, split-payment persistence, price authority, inventory/COGS effects, idempotency, concurrency, approvals, and reversal flows |
| Procurement and suppliers | No direct application tests | Receipt, payment, return/refund, and reversal workflows plus their authorization and accounting effects |
| Authentication and shell | No direct application tests | Session expiry, role changes, redirects, and route protection |

Database functions, RLS, migration constraints, audit records, inventory continuity, and security-definer boundaries require later isolated Supabase integration tests. They are not replaced by the source-level tests in this baseline.

## SQL verification artifacts

Recovered Phase 6 and Phase 7 SQL verification artifacts remain in place; their inventory and proposed documented copy location are in [SQL verification artifact inventory](recovery/sql-verification-artifacts/README.md). Their provenance is preserved and they are not part of CI.

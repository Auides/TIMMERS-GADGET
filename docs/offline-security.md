# Offline access and local-data security

## Scope and threat model

Phase 2 adds a local unlock mechanism for a previously authenticated employee on one browser installation. It protects future encrypted offline records from casual device sharing and at-rest IndexedDB inspection. It does not make the browser, a compromised device, or a page with malicious script trusted. No production business data is cached in this phase.

This document extends [the offline architecture](./offline-architecture.md). Supabase Auth and PostgreSQL remain the authoritative online identity and authorization systems.

## Online authentication is distinct from offline unlock

Online sign-in uses the existing Supabase session and the server's `getAuthenticatedProfile()` check. Offline enrollment is permitted only from that authenticated server context for an active `ADMIN`, `MANAGER`, or `STAFF` profile whose profile UUID matches the Supabase user UUID.

The offline passcode is separate. The application never stores, transmits, requests, or logs a Supabase password for local unlocking; it neither makes a local Supabase session nor forges a JWT. Online sign-out also clears the in-memory offline vault key, but does not erase a local enrollment.

## Device enrollment and cryptography

Each browser installation has a generated UUID in IndexedDB. A shared device can hold distinct enrollments for several employees, keyed by `(userId, deviceId)`. An enrollment stores only a minimal authorization snapshot, encrypted key-wrapping metadata, and local throttling state. It does not store a passcode, plaintext vault key, derived key, service-role key, token, or business record.

The browser Web Crypto API creates a random 256-bit AES-GCM data-encryption key (DEK). An offline passcode of at least eight characters derives a key-encryption key with PBKDF2-SHA-256, 600,000 iterations, and a fresh random 16-byte salt. The DEK is encrypted with AES-GCM and a fresh random 12-byte IV, using authenticated additional data bound to the crypto version, user UUID, and device UUID. Only the encrypted DEK, salt, and IV are persisted. Every future vault encryption must generate another IV; IVs are never reused with a key.

The unwrapped DEK exists only in the React provider's memory. Refreshing, closing, locking, or online sign-out clears it. There is no persisted `unlocked` flag and no key material in localStorage.

## Authorization and revalidation

When an authenticated online shell is rendered, its authoritative profile refreshes the enrolled display name, role snapshot, and `lastOnlineVerifiedAt`. An inactive or ineligible authoritative profile removes that employee's enrollment on that browser. This local snapshot is not a second authorization database.

An entirely disconnected device cannot learn that an employee was disabled until reconnection. There is deliberately no arbitrary hard offline-expiry period because extended outages are an approved operating requirement. Once connectivity returns, local enrollment revalidates immediately, and the server must reject any eventual pending operation that is no longer authorized.

Encryption does not replace authorization. Future repositories must cache only data allowed by the enrolled role snapshot. In particular, a Staff vault must not receive Manager/Admin cost or sensitive data merely because the vault is encrypted.

### Future serialized-inventory replication boundary

`public.staff_serialized_inventory_snapshot()` is the future read boundary for
encrypted, device-local serialized-inventory replication. It is not called by
the current offline flow, and this phase does not cache business data.

The RPC mirrors the existing staff serialized-lookup projection and visibility:
it returns one row per visible unit identifier for `AVAILABLE`, `SOLD`, and
`RETURN_PENDING` units, with catalogue retail price when present. It excludes
inventory economics and procurement information. It requires the existing
active-profile guard, uses a hardened `SECURITY DEFINER` search path, exposes
execution only to `authenticated`, and never replaces RLS or authorizes a
client-provided role.

## Encrypted read cache

Phase 3A permits only Staff and Manager offline catalogue and inventory reads.
Admin remains online-only. The browser asks the authenticated server route for
the existing safe non-serialized catalogue projection and the safe serialized
snapshot projection; it supplies no role, user ID, or authorization claim.

The client stores each resource only as AES-GCM ciphertext in IndexedDB V3.
Its additional authenticated data binds the payload to the enrolled user,
device, and resource, and the vault key remains memory-only. Refresh encrypts
both resources before one IndexedDB transaction replaces the previous complete
snapshot. A role change, deactivation, or local-enrollment removal purges that
user's encrypted business cache and locks the in-memory vault. The cache contains no WAC, acquisition cost,
COGS, supplier procurement, purchase, or mutation data.

### Phase 4A reference-data minimization

The encrypted cache may also contain only customer ID/name/phone/email and,
for a Manager, supplier ID/business/contact name/phone/email/active state. It
does not contain customer credit/debt, sales or payment history, supplier
costs, balances, purchases, refunds, procurement totals, margins, or notes.
STAFF receives no supplier records. Those fields are AES-GCM ciphertext at
rest; Dexie indexes only non-business scope and snapshot metadata, never names,
phones, or emails. Search structures are constructed only from decrypted data
held after vault unlock.

## Local throttling and session foundation

Repeated failed unlocks use an increasing, capped device-local delay; a successful unlock resets the counter. This slows casual guessing but cannot turn a weak passcode into a strong one, and an attacker controlling local browser storage may attempt to reset it.

For offline Staff and Manager workspaces, one hour of inactivity locks the vault and crossing into a new `Africa/Lagos` business date requires a fresh unlock. Admin retains the existing online operational model, although every offline vault locks after browser/app restart. Immutable server operational-session history is intentionally a later phase.

## Encrypted future mutation transport

Phase 4B adds an encrypted, user-and-device-scoped V4 local mutation transport
for a later approved offline-command phase. Each envelope uses the already
unlocked, memory-only vault DEK with AES-GCM and a fresh IV. Its authenticated
additional data binds the ciphertext to the crypto version, user, device,
operation ID, mutation type, and envelope schema version. The plaintext record
boundary is restricted to routing metadata: stable operation/idempotency IDs,
scope, type, state, timestamps, retry count, next-attempt time, schema version,
and generic status codes. Names, phones, identifiers, notes, quantities,
prices, costs, payments, and request bodies are ciphertext only.

The vault must be unlocked to decrypt or replay an operation. A role snapshot
does not confer replay authority: an online authenticated Supabase session,
active profile, current server-derived role, database rules, and business rules
are all required when a future executor is approved. Enrollment disablement or
deactivation removes the encrypted queue and conflict records from this device;
role changes leave the encrypted queue in place but its future replay is
re-authorized by the server. No service worker stores or replays operations.

### Phase 5A customer-create boundary

The only live executor is `CUSTOMER_CREATE`. Its encrypted payload holds the
minimum existing customer fields: a stable client-generated UUID, trimmed full
name, optional phone, and optional email. No cached role, credit/balance,
history, address, payment, or unrelated profile information is included. The
same name, phone, or email never appears in V4 plaintext metadata or a local
shadow record.

The source-only database boundary uses a deferred customer foreign key and a
unique operation/idempotency reservation inside one transaction. A response
lost after commit is safe: repeating the same operation under the same active
actor returns the previously created customer rather than inserting another.
The RPC independently checks the active profile and current role on every
attempt, maps conflicts/rejections to generic local codes, and never returns
raw database errors for persistent diagnostics.

### Phase 5B customer-update concurrency boundary

`CUSTOMER_UPDATE` uses the same V4 ciphertext-only envelope and the same
memory-only unlocked vault as customer creation. Its additional plaintext field
inside the encrypted request is the customer reference snapshot's server-issued
`customerVersion` (`customers.updated_at`), never a client time or cached role.
Names, phones, emails, and the expected version are not placed in IndexedDB
metadata, the legacy outbox, service-worker caches, or diagnostic text.

Replay re-checks the authenticated session, active profile, and current server
role before the database function processes the operation. The function locks a
matching idempotency reservation before comparing the current customer version.
Thus a response lost after a committed update returns the committed result on
retry, rather than treating the operation as stale against itself. A genuinely
stale expected version returns only a generic conflict code; authorization and
validation failures return generic rejections. The encrypted proposed update
remains available only after the owner unlocks the vault, and no automatic
conflict retry or last-write-wins fallback exists.

### Phase 6A supplier-create boundary

`SUPPLIER_CREATE` uses the same V4 ciphertext-only envelope, memory-only vault
key, and user/device AAD binding. Its payload contains only a stable supplier
UUID, business name, and optional contact name, phone, and email; it contains
no supplier balance, procurement data, costs, payments, notes, cached role, or
authorization decision. Supplier names and contact values never occur in
plaintext IndexedDB metadata, the legacy outbox, service-worker caches, or
stored diagnostic text.

Queueing and replay are deliberately Manager-only. STAFF has no supplier
creation UI or queue capability, and Admin offline support remains unapproved.
The authenticated endpoint and the hardened `SECURITY DEFINER` function both
derive and check the current active profile role on every replay. The durable
operation/idempotency reservation validates the original actor, supplier UUID,
and canonical request fingerprint before returning an existing success. This
makes an ambiguous lost response safe without trusting a cached role or exposing
raw database errors. Supplier UPDATE and every procurement command remain
online-only.

### Phase 6B supplier-update boundary

`SUPPLIER_UPDATE` uses the encrypted V4 mutation transport and is available only
to an unlocked Manager. Its ciphertext contains the supplier UUID, the narrow
editable supplier fields, and the authoritative `expectedVersion` supplied by
the encrypted Manager snapshot. The version token is server-owned
`suppliers.updated_at`; no cached role or client clock is trusted.

The server rechecks the authenticated active profile and current Manager role
at replay time. Durable idempotency is resolved before the supplier version is
compared, so retrying a request whose response was lost after commit returns the
original applied result instead of producing a false conflict. A genuinely
stale version becomes terminal `CONFLICT` and never overwrites newer server
data.

Pending supplier creates cannot be updated offline, and an existing PENDING,
SYNCING, or CONFLICT update prevents another offline update for the same
supplier. Proposed edits remain encrypted at rest and are shown separately from
the authoritative cached supplier record only while the vault is unlocked.
The service worker and legacy plaintext outbox never receive or replay supplier
update payloads.

## Phase 6C-B procurement receipt boundary

Only an unlocked Manager vault can encrypt a `PURCHASE_RECEIVE` payload. It is
user/device-scoped V4 AES-GCM ciphertext; plaintext metadata, service-worker
caches, localStorage, and the legacy outbox never contain supplier references,
notes, quantities, or acquisition costs. STAFF never receives supplier cache
and cannot queue or view procurement receipts; ADMIN remains online-only.

The client accepts only canonical decimal strings for acquisition cost and does
not calculate WAC, totals, or inventory state. The authenticated route checks
the current profile role again, and the `SECURITY DEFINER` wrapper checks the
active profile/current Manager role again with a hardened search path. It
requires `initial_payments` to be the exact empty array and rejects every
serialized line before it invokes the established transaction. The existing
transaction's reservation binds replay to the current actor and canonical
fingerprint, so retries cannot duplicate a receipt.
## Risks and next steps

IndexedDB is not a hardware-backed secure store. A compromised, unlocked browser or XSS can access data available to the page, so strong CSP, dependency hygiene, device controls, and fast lock behavior remain essential. Shared-device employees should lock before handing off a device and disable enrollment on retirement/replacement.

Future phases may add approved operation-specific executors and server-side
operational-session auditing. They must not weaken server-side RLS, audit,
financial, inventory, idempotency, or concurrency protections.

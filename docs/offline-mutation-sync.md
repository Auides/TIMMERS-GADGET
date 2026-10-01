# Offline mutation synchronization

## Scope

Phase 4B creates local transport infrastructure only. No customer, supplier,
catalogue, purchase, inventory, sale, payment, return, credit, or procurement
mutation is enabled offline, and the executor registry is intentionally empty.
The service worker remains shell/static-cache-only and cannot store or replay a
business operation, session, token, payment, stock change, or sale.

## Envelope and encryption

The V4 `encryptedMutationOutbox` table is the only permitted future business
queue. Every operation has a stable `operationId`, `idempotencyKey`, `userId`,
`deviceId`, mutation type, and schema version. Its JSON request body is
AES-GCM ciphertext, encrypted with a new 12-byte IV by the unlocked memory-only
vault DEK. AAD binds ciphertext to the user, device, operation ID, mutation
type, crypto version, and schema version. Thus data cannot be substituted across
users, devices, operations, types, or versions.

The persisted plaintext boundary contains only non-sensitive routing metadata:
operation/idempotency IDs, user/device scope, type, state, timestamps, retry
count, next-attempt time, schema version, and a generic machine-readable status
code. It never contains a request body, contact detail, identifier, note,
quantity, price, cost, payment, or financial value. Conflict rows use the same
boundary; detailed conflict context is separately encrypted and generic reason
codes replace database error text.

The former Phase 1 `outbox` and `syncConflicts` tables are a documented inert
prototype. No production operation was written to them, and no future business
command may use them. This V4 transport therefore upgrades the business-data
path before any offline mutation can be approved, without trying to decrypt or
reinterpret prototype plaintext.

## State machine, ordering, and recovery

The only states are `PENDING`, `SYNCING`, `APPLIED`, `CONFLICT`, and `REJECTED`.
The allowed transitions are:

```
PENDING -> SYNCING
SYNCING -> PENDING | APPLIED | CONFLICT | REJECTED
```

`APPLIED`, `CONFLICT`, and `REJECTED` are terminal and never automatically
retried. A transient transport failure returns `SYNCING` to `PENDING`, retains
the original operation ID and idempotency key, increments retry metadata, and
sets a capped deterministic exponential next-attempt time. The application
controls when synchronization is requested; there is no service-worker or
tight background retry loop.

Queue processing is one-at-a-time and deterministic by `createdAt`, then
`operationId`. At an application-controlled synchronization start, stale local
`SYNCING` records older than the configured recovery window become `PENDING`
with their original identity and idempotency key. This prevents a browser crash
from permanently blocking a queue without creating a duplicate request.

## Future authorization and lifecycle contract

Future replay requires an unlocked vault plus an online authenticated Supabase
session and active profile. A future executor must send the stable idempotency
key but must never trust cached role data: the server derives the current role,
checks current permissions, and enforces database/RLS and business rules. A
former Manager who is now Staff may retain encrypted operations locally, but
unauthorized replay must be returned as `REJECTED` (or `CONFLICT` where the
server identifies a business-state conflict).

If the account is deactivated or offline enrollment is disabled, local
enrollment removal erases its encrypted queue and conflict records; nothing is
automatically applied. While the vault is locked, no payload can be decrypted
or replayed. This preserves the existing cache-purge and shared-device model.

## Future executor approval

An executor is a typed, application-controlled dispatcher entry. It receives a
decrypted payload only after local scope and unlock checks, and may report only
`APPLIED`, retryable transient failure, `CONFLICT`, or `REJECTED`. A stored
unknown type is rejected with a generic code rather than executed or retried.

## Phase 5A: CUSTOMER_CREATE

`CUSTOMER_CREATE` is the first and only registered real executor. It carries a
stable client-generated customer UUID, full name, optional phone, and optional
email inside the encrypted envelope. Existing customer rules are preserved:
full name is trimmed and nonblank; phone and email remain optional and no new
duplicate rule has been created for either field. Customer update and every
supplier, catalogue, inventory, purchase, payment, sale, return, refund,
credit, discount, or expense mutation remains unimplemented and fails safely.

Its source-only server boundary owns a small durable reservation table with
unique operation and idempotency identities. In the same transaction it checks
the active authenticated actor/current role, creates and audits the customer,
and records the result. A lost response followed by retry therefore returns the
existing result rather than a second customer. The server is authoritative for
current authorization: role loss/deactivation results in a generic terminal
rejection, while actual business/idempotency conflicts are terminal conflicts.
The application refreshes the authorized encrypted customer snapshot after an
applied replay; pending decrypted local projections are not authoritative data.

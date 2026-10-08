# Offline mutation synchronization

## Phase 7A-C post-replay adjustment-request reconciliation

`INVENTORY_ADJUSTMENT_REQUEST_CREATE` remains the sixth and final registered mutation. After its replay engine finishes, the client may refresh a separate encrypted authoritative status resource, then refresh the established read snapshot only when replay applied or conflicted work. Neither refresh is an executor, does not enqueue an operation, and does not alter local inventory, WAC, unit lifecycle, or approval state.

Pending local request intent, server `OPEN`, server `RESOLVED`, and server `REJECTED` remain distinct states. The status resource is read-only and a later authenticated refresh can repair it after an availability failure without replaying a terminal or applied envelope.

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
duplicate rule has been created for either field. Every supplier, catalogue,
inventory, purchase, payment, sale, return, refund,
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

## Phase 5B: CUSTOMER_UPDATE

The only registered business executors are now `CUSTOMER_CREATE` and
`CUSTOMER_UPDATE`; every supplier, catalogue, inventory, purchase, payment,
sale, return, refund, credit, discount, or expense mutation remains offline
unimplemented. `CUSTOMER_UPDATE` carries one server-confirmed customer ID, the
existing editable customer fields, and the exact server-issued snapshot version
inside V4 ciphertext.

The source-only replay function owns a durable operation/idempotency reservation
and processes a retry in this order: re-authorize the current actor, locate and
validate a prior committed reservation, then lock and compare the customer
version for a new operation. This ordering makes an after-commit response loss
idempotently `APPLIED`; it cannot create another update or become stale against
the same update. If another actor has changed the customer, the expected version
does not match and the operation is terminal `CONFLICT`, is never automatically
retried, and preserves its encrypted proposed edit for explicit future review.

Validation failures, role loss, and deactivation are terminal `REJECTED` with
generic codes. Transient transport failures retain the original operation and
idempotency IDs. A pending local create or any open/conflicted update for the
same customer blocks a new update; dependency graphs and conflict merges are
explicitly out of scope for this phase.

## Phase 6A: SUPPLIER_CREATE

`SUPPLIER_CREATE` is the third registered executor. It is available only to a
Manager and carries a stable client-generated supplier UUID, business name,
optional contact name, optional phone, and optional email inside V4 ciphertext.
STAFF has no supplier queue or mutation UI; Admin offline work is not expanded
here. The legacy plaintext outbox and service worker never store, decrypt, or
replay supplier requests.

The source-only server boundary creates a Manager-only durable reservation with
unique operation and idempotency identities plus a canonical request
fingerprint. It first rechecks the active authenticated actor/current role,
then creates and audits the supplier in the same transaction for a new
reservation. A retry after a lost response validates the original actor and
fingerprint and returns the original supplier ID, preventing a duplicate. No
new uniqueness rule is imposed on business name, phone, or email; the existing
online supplier-create semantics are preserved.

## Phase 6B: SUPPLIER_UPDATE

`SUPPLIER_UPDATE` is the fourth registered executor and remains Manager-only.
Its encrypted payload contains only the supplier UUID, the existing editable
business/contact fields, and the authoritative `expectedVersion` from the
Manager supplier snapshot. The version is sourced from server-maintained
`suppliers.updated_at`.

Before queueing, a pending local supplier create blocks editing that supplier,
and an existing PENDING, SYNCING, or CONFLICT supplier update blocks another
offline update. The encrypted proposal remains separate from the authoritative
cached supplier record.

Replay first rechecks the current authenticated session, active profile, and
Manager role. The server resolves an existing matching operation/idempotency
reservation before comparing the supplier version, so a lost-response retry
returns the original committed result and becomes APPLIED rather than a false
conflict. For a new operation, the supplier row is locked and its authoritative
version is compared with `expectedVersion`. A stale version is terminal
`CONFLICT`; newer server data is never overwritten and the operation is not
retried as transient.

A successful update preserves the existing archived-supplier business-name
rule, records the resulting server version, writes the procurement audit entry,
and refreshes the encrypted supplier reference snapshot. Validation, role loss,
and deactivation are terminal `REJECTED` outcomes. The legacy plaintext outbox
and service worker remain outside all business mutation replay.

All procurement, inventory, catalogue, sales, payment, return, refund, credit,
discount, expense, supplier archival, and other unapproved mutations remain
unregistered.

## Phase 6C-B: PURCHASE_RECEIVE

`PURCHASE_RECEIVE` is the fifth registered executor. It queues only a
Manager's nonserialized purchase-receipt intent: supplier, received date,
optional reference/notes, and one or more positive-integer line payloads with
product/optional variant, condition, canonical decimal-string unit acquisition
cost, and optional notes. The payload requires the exact `initialPayments: []`
array. It has no serialized units, payment instrument, client WAC, purchase
total, stock revision, or local inventory projection.

The executor posts the stable V4 idempotency identity to the narrow
same-origin route. The route and database wrapper recheck current Manager
authorization; role loss/deactivation is terminal rejection. The wrapper
rejects payments and serialized products and delegates to the established
`purchase_receive` transaction, whose existing canonical fingerprint and
actor-bound reservation resolve an ambiguous retry without duplication. The
legacy outbox and service worker never store, decrypt, or replay this command.

## Phase 6C-C: serialized PURCHASE_RECEIVE replay

`PURCHASE_RECEIVE` is still the fifth and final approved executor. Its
serialized form carries only per-unit actual acquisition cost, optional
warranty dates, and established identifier intent; it always carries
`initialPayments: []`. The API converts that narrow encrypted intent to the
existing `purchase_receive` input shape. It does not calculate WAC, assign
unit state, create a client ID, or implement a second receipt transaction.

The authoritative receipt reservation/fingerprint runs before a completed
retry makes any new uniqueness decision, so a lost response replays its
original result as APPLIED rather than conflicting with its own identifiers.
For a new request, any identifier collision is mapped to safe terminal
`PURCHASE_RECEIVE_CONFLICT`; the encrypted intent is retained for Manager
review and is never automatically retried. The existing server transaction is
all-or-nothing, including mixed serialized/nonserialized receipt effects.

## Phase 6C-D: initial supplier payments within the fifth command

This phase supersedes the earlier `initialPayments: []` restriction.
`PURCHASE_RECEIVE` remains the fifth and only offline procurement mutation; it
may carry zero or more initial payments with nonserialized and/or serialized
receipt lines. There is no standalone supplier-payment command, no sixth
mutation, and no offline reversal.

The encrypted payload has only canonical decimal-string amount, an established
method, paid date, and optional reference/notes. The route and wrapper reject
authority fields and delegate to `purchase_receive`, which authoritatively
checks Lagos date, method, aggregate amount against the server-calculated total,
and the atomic ledger/inventory write. Pending intent affects no payable,
balance, report, or payment history. The canonical receipt/payment fingerprint
and actor-bound reservation make an exact lost-response retry return the
original result without duplicate payment or inventory effects.

## Phase 7A-B: `INVENTORY_ADJUSTMENT_REQUEST_CREATE`

The registry's exact order is `CUSTOMER_CREATE`, `CUSTOMER_UPDATE`, `SUPPLIER_CREATE`, `SUPPLIER_UPDATE`, `PURCHASE_RECEIVE`, then `INVENTORY_ADJUSTMENT_REQUEST_CREATE`; no other mutation type is registered. The V4 envelope carries stable operation and idempotency UUIDs while its strict business payload remains encrypted. A durable server operation row binds actor, operation, idempotency key, and canonical fingerprint to one resulting adjustment-request row, so an exact retry returns that original row and any mismatch becomes a generic terminal conflict.

The executor maps stale serialized availability and idempotency conflicts to terminal `CONFLICT`; malformed input, role loss, deactivation, and validation failures are terminal `REJECTED`; only unavailable server/network conditions retry. Replay invokes only the request-creation wrapper, which delegates to the existing request submitter and its established audit event. It does not call inventory execution or mutate cached inventory. Service workers and the legacy outbox neither store nor replay this command.

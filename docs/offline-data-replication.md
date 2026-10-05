# Offline data replication

Phase 3A stores a complete, encrypted, user-and-device-scoped read snapshot in
IndexedDB. It contains only the approved catalogue/non-serialized stock and
serialized inventory fields returned by the authenticated snapshot boundary.
The decrypted snapshot and vault key remain in memory only; neither business
data nor a vault key is placed in localStorage or service-worker caches.

Phase 3B consumes that same snapshot for normal Catalogue and Inventory
fallback. Connected normal routes retain their authoritative server reads.
When disconnected, the safe local routes and the in-place client fallback
decrypt the unlocked user's existing snapshot for read-only search and display.
The view reports its last successful sync and cached/stale nature. It never
claims real-time global inventory consistency.

There is no snapshot means no offline data: the UI directs the user to reconnect
and refresh rather than treating the state as zero inventory. A locked vault
does not expose ciphertext or raw business data; it directs the user to
`/offline/unlock` and resumes only an allow-listed return path after a fresh
unlock.

Refresh is explicit and online-only through the existing authenticated Phase 3A
endpoint. It is atomic: a prior complete encrypted snapshot remains available
if replacement fails. Role change, deactivation, and user/device boundaries
continue to purge or deny cache access. STAFF and MANAGER remain the only
offline read roles in this phase. ADMIN offline capability is deliberately
future work and must be designed and approved before it is enabled.

No catalogue, inventory, sales, purchase, return, or other business mutation
uses this cache or is offline-enabled. Phase 4B has an encrypted transport
foundation only; it registers no real business executor and does not replay any
business command. Its eventual replay contract is documented in
[offline mutation sync](./offline-mutation-sync.md).

## Phase 5A pending customer reconciliation

Offline customer creation does not alter the encrypted authoritative reference
snapshot. Pending customer projections are derived only in memory by decrypting
the current user's `CUSTOMER_CREATE` envelope after vault unlock, and are
visibly marked pending synchronization. After the narrow authenticated replay
command reports `APPLIED`, the application refreshes the permitted encrypted
customer snapshot; the applied operation is retained for non-replay history but
is excluded from the pending projection. Rejections and conflicts remain
terminal and never enter the cache as confirmed customers.

## Phase 5B customer-update reconciliation

Customer reference rows now include only one additional non-financial field:
the authoritative server `customerVersion`, derived from `customers.updated_at`.
It is encrypted with the rest of the user/device-scoped customer resource and
is retained exactly with the cached customer record. It authorizes neither a
role nor a client clock; it is only an optimistic-concurrency expectation sent
inside the encrypted `CUSTOMER_UPDATE` payload.

While unlocked, the UI derives pending customer edits by decrypting that
customer's `CUSTOMER_UPDATE` envelope in memory. It retains the authoritative
cached record separately, marks the proposal pending, and writes no plaintext
edited-customer shadow. A successful replay refreshes the complete encrypted
reference snapshot and replaces the old version. A stale conflict is terminal,
preserves the encrypted proposal for later review, and may still refresh the
authoritative snapshot; it never silently overwrites it. Pending-created
customers cannot enter an update workflow until their create operation has
applied.

## Phase 4A reference datasets

The atomic snapshot additionally carries minimized customer reference records
for STAFF/MANAGER and supplier reference records only for MANAGER. The server
derives the role from the authenticated active profile and returns an empty
supplier dataset for STAFF; encryption never expands authorization. Every
customer/supplier record remains ciphertext at rest, with fresh AES-GCM IVs and
user/device/resource/version-bound AAD. No plaintext contact search index is
persisted.

Offline searches are in-memory after an unlock. The customer/supplier views use
the same locked, no-cache, stale, and explicit-refresh states as existing
offline reads. At the Phase 4A reference-data boundary they were read-only;
purchases, payments, refunds, sales, returns, and all other unapproved commands
stay online-only and never use the outbox.

## Phase 6A pending supplier reconciliation

Managers may additionally create a supplier while disconnected. The new record
is not written into the cached supplier snapshot or any plaintext projection:
the pending row is derived only after the owner unlocks and decrypts the
current user's `SUPPLIER_CREATE` V4 envelope in memory. It is visibly marked
pending and cannot be mistaken for a server-confirmed supplier.

After an applied replay, the existing authenticated snapshot refresh replaces
that in-memory pending projection with the authoritative supplier record. The
applied operation remains terminal history and is excluded from pending rows.
Rejected/conflicted operations do not enter the snapshot.

## Phase 6B supplier update replication and reconciliation

The Manager supplier snapshot now also carries `supplierVersion`, sourced from
the authoritative server-maintained `suppliers.updated_at` value. This token is
replicated only as part of the encrypted supplier reference snapshot and is used
as the optimistic-concurrency precondition for `SUPPLIER_UPDATE`.

A proposed supplier edit is not merged into the authoritative cached supplier
record. While unlocked, the UI derives the proposed values from the encrypted
V4 mutation envelope and presents them separately from the authoritative cached
record. PENDING and SYNCING proposals remain local pending work; CONFLICT
proposals remain visible for review and do not alter the cached server record.

A supplier with a pending local create cannot be updated offline, and an
existing PENDING, SYNCING, or CONFLICT update blocks another offline edit for
that supplier. On successful replay, the authenticated supplier snapshot is
refreshed and the new authoritative version replaces the prior cached record.
On stale-version conflict, no server data is overwritten and the cached
authoritative supplier remains unchanged.

Purchases, payments, refunds, supplier archival, and every other unapproved
procurement/inventory operation remain online-only.

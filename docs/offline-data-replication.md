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
offline reads. They are reference-only: customer/supplier mutations, purchases,
payments, refunds, sales, and returns stay online-only and never use the outbox.

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
uses this cache or enters the outbox in Phase 3B.

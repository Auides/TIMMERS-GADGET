# Offline-first architecture foundation

## Purpose and authority

TIMMERS GADGET is moving toward an offline-first operational application so an installed mobile or computer application can remain usable during connectivity loss. This Phase 1 foundation does not make any business workflow offline-capable. Supabase/PostgreSQL remains the authoritative server-side system after synchronization, and existing database authorization, RLS, audit, financial, inventory, idempotency, and concurrency protections are not bypassed.

## Local foundation

The browser uses Dexie over IndexedDB with only four foundation tables: `metadata`, `device`, `outbox`, and `syncConflicts`. No production business tables or sensitive production business records are copied locally in this phase.

- `metadata` holds the local schema version and is reserved for sync timestamps and checkpoints.
- `device` holds one generated UUID installation identity and ISO timestamps. It is not hardware fingerprinting or surveillance.
- `outbox` holds future mutation envelopes with a UUID, aggregate metadata, decimal-string-capable JSON payload, stable idempotency key, retry state, and server result metadata.
- `syncConflicts` holds a local payload, optional server payload, description, detection timestamp, and future resolution placeholder.

IndexedDB is not an automatically encrypted secure database. Do not store Supabase service-role keys, passwords, access credentials, private API tokens, or sensitive production business records there. Offline authentication and local-data encryption are separate future phases.

### Deferred serialized-inventory snapshot

Phase 3A-0 adds only the database read boundary for a later encrypted snapshot:
`staff_serialized_inventory_snapshot()`. No application code invokes it and no
business data is stored offline in this phase. A later replication implementation
must use this RPC as its source, retain the offline-access vault safeguards, and
must not treat it as an RLS replacement or an inventory-command interface.

## Phase 3A read-only workspace

The offline workspace displays only an unlocked user's encrypted snapshot of
catalogue/non-serialized stock and serialized inventory. Refresh is explicit
and online-only through `/api/offline/read-snapshot`; its response is private
and `no-store`, and the service worker never caches that API response. The
service worker caches only the safe offline shell routes and static assets.

This cache does not use the outbox and does not introduce offline commands.
Sales, checkout, stock changes, catalogue changes, purchases, returns, and all
other business mutations remain online-only.

## Phase 3B normal-route read fallback

Catalogue and inventory now retain their normal authoritative server-rendered
paths while connected. If connectivity is lost after either screen loads, a
client-only overlay reads the unlocked user's encrypted V3 snapshot from memory
and renders a read-only local equivalent. A navigation to `/app/catalogue` or
`/app/inventory` that cannot reach the network is redirected by the service
worker to the safe, precached `/offline/catalogue` or `/offline/inventory`
route. The service worker still never caches authenticated `/app` HTML or the
snapshot API response.

The fallback reports that its data is offline, shows the last successful sync
time and staleness, and says explicitly that cached inventory is this device's
last synchronized state rather than globally current stock. It permits only
local product/SKU/barcode and IMEI/serial searching. No arbitrary expiry is
applied.

An offline locked vault shows `Offline data is locked.` and links to the
offline unlock flow, preserving a restricted return path. An unlocked vault
with no complete snapshot shows a distinct no-cache state; it never represents
missing data as zero stock. Refresh remains a deliberate online action and
requires the existing valid session, active user verification, and unlocked
vault supplied by the Phase 3A refresh boundary.

Catalogue changes, price changes, archives, opening stock, adjustment
requests, direct/serialized adjustments, and every other business mutation
remain online-only. These paths are not sent to the outbox. STAFF and MANAGER
can use the minimized encrypted read cache; ADMIN is intentionally online-only.
TODO: the final approved offline architecture must include Admin offline
functionality so the full product-owner offline requirement is met.

## Synchronization lifecycle

Future enabled modules will create an outbox item locally, retaining its UUID and idempotency key for every retry. The sync engine processes pending items in deterministic `createdAt`, then UUID order and permits only one loop at a time. Network failures return an item to `PENDING` with an incremented retry count; business conflicts become `CONFLICT`; unexpected permanent failures may become `FAILED`; successful items become `SYNCED` with reconciliation metadata.

Phase 1 has no live operation adapter and sends no business RPCs to Supabase. Startup, connectivity restoration, and a later explicit user action are intended sync triggers once approved operation handlers exist.

## Connectivity and conflicts

Browser online/offline events are only a signal. When the browser reports online but server reachability is unknown, state is `CHECKING`; a future health signal can report `ONLINE` or `DEGRADED`. The authenticated shell shows this non-sensitive state and a pending outbox count.

Two disconnected devices cannot know about each other's unsynchronized transactions. Future synchronization must therefore detect conflicts rather than pretend that global inventory consistency exists offline. This is especially important for serialized inventory, stock quantities, financial state, and audit history.

## PWA policy

The Next.js manifest enables standalone installation and uses the existing favicon only; no final logo is fabricated. The service worker has an explicitly versioned cache, removes obsolete application caches, caches only same-origin static assets, and uses network-first navigation with the public `/offline` fallback.

It does not cache Supabase authenticated responses, mutations, arbitrary non-GET requests, sensitive dynamic financial responses, or authenticated HTML. Full business-table caching is intentionally absent until each module has an approved conflict and reconciliation design.

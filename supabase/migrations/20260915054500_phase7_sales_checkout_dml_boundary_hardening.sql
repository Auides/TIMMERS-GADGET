-- TIMMERS GADGET - Phase 7 Migration 3C direct-DML boundary hardening.
--
-- The core inventory tables predate the later RPC-only transactional boundary
-- and still carry inherited browser-role write privileges. Existing application
-- code reads these tables directly where permitted by RLS, but all operational
-- writes are performed through hardened SECURITY DEFINER commands.
--
-- Preserve SELECT behavior; remove direct browser INSERT/UPDATE/DELETE only.

revoke insert, update, delete
on table
  public.inventory_movements,
  public.stock_buckets,
  public.serialized_units
from public, anon, authenticated;

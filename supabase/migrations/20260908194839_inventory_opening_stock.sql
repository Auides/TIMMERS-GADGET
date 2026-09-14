-- Phase 5 proposal only. Do not apply until Product Owner review approval.
-- This is intentionally isolated so OPENING_STOCK is committed before the
-- following migration defines functions that use the enum value.
alter type public.movement_type add value if not exists 'OPENING_STOCK';
alter type public.unit_status add value if not exists 'ADJUSTED_OUT';

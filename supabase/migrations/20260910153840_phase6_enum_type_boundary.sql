-- Phase 6 Migration 1: isolated enum/type boundary.
-- Later migrations may safely reference these values after this migration commits.

alter type public.unit_status add value if not exists 'PURCHASE_REVERSED';
alter type public.unit_status add value if not exists 'RETURNED_TO_SUPPLIER';

alter type public.movement_type add value if not exists 'PURCHASE_REVERSAL';
alter type public.movement_type add value if not exists 'SUPPLIER_RETURN';
alter type public.movement_type add value if not exists 'SUPPLIER_RETURN_REVERSAL';

create type public.supplier_payment_method as enum (
  'CASH',
  'POS',
  'BANK_TRANSFER',
  'OTHER'
);

create type public.procurement_operation_kind as enum (
  'PURCHASE_RECEIPT',
  'SUPPLIER_PAYMENT',
  'SUPPLIER_RETURN',
  'SUPPLIER_REFUND_RECEIPT',
  'PURCHASE_REVERSAL',
  'SUPPLIER_PAYMENT_REVERSAL',
  'SUPPLIER_RETURN_REVERSAL',
  'SUPPLIER_REFUND_RECEIPT_REVERSAL'
);

-- TIMMERS GADGET - Phase 7: sales enum/type boundary.
-- Additive only. Sales tables, workflows, grants, and RLS follow in later migrations.

alter type public.movement_type add value if not exists 'SALE_REVERSAL';

create type public.sale_kind as enum (
  'ORDINARY',
  'CREDIT'
);

create type public.sale_payment_kind as enum (
  'CHECKOUT',
  'CREDIT_REPAYMENT'
);

create type public.sale_approval_decision as enum (
  'APPROVED',
  'REJECTED'
);

create type public.sales_operation_kind as enum (
  'CHECKOUT_CUSTOMER_CREATE',
  'DISCOUNT_REQUEST',
  'DISCOUNT_DECISION',
  'CREDIT_REQUEST',
  'CREDIT_DECISION',
  'CHECKOUT_FINALIZATION',
  'CREDIT_REPAYMENT',
  'PAYMENT_REVERSAL',
  'SALE_REVERSAL',
  'SALES_SETTINGS_UPDATE'
);

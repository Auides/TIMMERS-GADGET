-- TIMMERS GADGET - Phase 7 Migration 2: sales schema, integrity, and RLS.
-- This migration intentionally does not add checkout, approval, payment, or
-- reversal command RPCs. Those workflows must be introduced atomically later.

create sequence public.sale_number_seq as bigint start with 1 increment by 1 no cycle;

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  sale_number bigint not null default nextval('public.sale_number_seq'::regclass),
  customer_id uuid references public.customers(id) on delete restrict,
  sale_kind public.sale_kind not null,
  transaction_on date not null,
  customer_name_snapshot text,
  customer_phone_snapshot text,
  gross_subtotal numeric(14,2) not null check (gross_subtotal >= 0),
  discount_total numeric(14,2) not null default 0 check (discount_total >= 0 and discount_total <= gross_subtotal),
  final_total numeric(14,2) not null check (final_total = gross_subtotal - discount_total),
  notes text check (notes is null or (notes = btrim(notes) and notes <> '')),
  discount_request_id uuid,
  credit_request_id uuid,
  finalized_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (sale_number),
  check (
    (customer_id is null and customer_name_snapshot is null and customer_phone_snapshot is null)
    or (customer_id is not null and customer_name_snapshot is not null and customer_name_snapshot = btrim(customer_name_snapshot) and customer_name_snapshot <> ''
        and (customer_phone_snapshot is null or (customer_phone_snapshot = btrim(customer_phone_snapshot) and customer_phone_snapshot <> '')))
  ),
  check (sale_kind <> 'CREDIT' or customer_id is not null)
);
alter sequence public.sale_number_seq owned by public.sales.sale_number;

create table public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  line_number integer not null check (line_number > 0),
  product_id uuid not null references public.products(id) on delete restrict,
  variant_id uuid,
  condition public.product_condition not null,
  product_name_snapshot text not null check (product_name_snapshot = btrim(product_name_snapshot) and product_name_snapshot <> ''),
  variant_label_snapshot text check (variant_label_snapshot is null or (variant_label_snapshot = btrim(variant_label_snapshot) and variant_label_snapshot <> '')),
  tracking_mode_snapshot boolean not null,
  quantity integer not null check (quantity > 0),
  gross_unit_price numeric(14,2) not null check (gross_unit_price >= 0),
  gross_subtotal numeric(14,2) not null check (gross_subtotal = quantity * gross_unit_price),
  allocated_discount numeric(14,2) not null default 0 check (allocated_discount >= 0 and allocated_discount <= gross_subtotal),
  net_revenue numeric(14,2) not null check (net_revenue = gross_subtotal - allocated_discount),
  nonserialized_wac_snapshot numeric(14,2) check (nonserialized_wac_snapshot >= 0),
  total_cogs_snapshot numeric(14,2) not null check (total_cogs_snapshot >= 0),
  created_at timestamptz not null default now(),
  foreign key (variant_id, product_id) references public.product_variants(id, product_id) on delete restrict,
  unique (sale_id, line_number),
  unique (id, sale_id),
  check (
    (tracking_mode_snapshot and nonserialized_wac_snapshot is null)
    or (not tracking_mode_snapshot and nonserialized_wac_snapshot is not null)
  )
);

create table public.sale_serialized_units (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  sale_line_id uuid not null,
  serialized_unit_id uuid not null references public.serialized_units(id) on delete restrict,
  acquisition_cost_snapshot numeric(14,2) not null check (acquisition_cost_snapshot >= 0),
  serialized_unit_identifier_snapshot text not null check (serialized_unit_identifier_snapshot = btrim(serialized_unit_identifier_snapshot) and serialized_unit_identifier_snapshot <> ''),
  unit_revision_before bigint check (unit_revision_before >= 0),
  unit_revision_after bigint,
  created_at timestamptz not null default now(),
  foreign key (sale_line_id, sale_id) references public.sale_lines(id, sale_id) on delete restrict,
  unique (sale_line_id, serialized_unit_id),
  unique (sale_id, serialized_unit_id),
  check (
    (unit_revision_before is null and unit_revision_after is null)
    or (unit_revision_before is not null and unit_revision_after = unit_revision_before + 1)
  )
);

create table public.sale_reversals (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null unique references public.sales(id) on delete restrict,
  reason text not null check (reason = btrim(reason) and reason <> ''),
  reversed_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  payment_kind public.sale_payment_kind not null,
  amount numeric(14,2) not null check (amount > 0),
  method public.supplier_payment_method not null,
  paid_on date not null,
  reference text check (reference is null or (reference = btrim(reference) and reference <> '')),
  notes text check (notes is null or (notes = btrim(notes) and notes <> '')),
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.sale_payment_reversals (
  id uuid primary key default gen_random_uuid(),
  sale_payment_id uuid not null unique references public.sale_payments(id) on delete restrict,
  sale_reversal_id uuid references public.sale_reversals(id) on delete restrict,
  reason text not null check (reason = btrim(reason) and reason <> ''),
  reversed_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.sale_discount_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  checkout_snapshot jsonb not null check (jsonb_typeof(checkout_snapshot) = 'object'),
  request_fingerprint text not null check (request_fingerprint = lower(btrim(request_fingerprint)) and request_fingerprint <> ''),
  requested_discount_amount numeric(14,2) not null check (requested_discount_amount > 0),
  gross_subtotal_snapshot numeric(14,2) not null check (gross_subtotal_snapshot > 0),
  customer_id uuid references public.customers(id) on delete restrict,
  customer_name_snapshot text check (customer_name_snapshot is null or (customer_name_snapshot = btrim(customer_name_snapshot) and customer_name_snapshot <> '')),
  sale_kind public.sale_kind not null,
  created_at timestamptz not null default now(),
  check (requested_discount_amount <= gross_subtotal_snapshot)
);

create table public.sale_discount_decisions (
  id uuid primary key default gen_random_uuid(),
  sale_discount_request_id uuid not null unique references public.sale_discount_requests(id) on delete restrict,
  decision public.sale_approval_decision not null,
  decided_by uuid not null references public.profiles(id) on delete restrict,
  approved_discount_amount numeric(14,2),
  manager_discount_max_percent_snapshot numeric(5,2),
  admin_below_cost_authorized boolean not null default false,
  reason text check (reason is null or (reason = btrim(reason) and reason <> '')),
  created_at timestamptz not null default now(),
  check (
    (decision = 'APPROVED' and approved_discount_amount is not null and approved_discount_amount > 0
      and manager_discount_max_percent_snapshot is not null and manager_discount_max_percent_snapshot between 0 and 100)
    or (decision = 'REJECTED' and approved_discount_amount is null and manager_discount_max_percent_snapshot is null
      and admin_below_cost_authorized = false)
  )
);

create table public.sale_credit_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  customer_name_snapshot text not null check (customer_name_snapshot = btrim(customer_name_snapshot) and customer_name_snapshot <> ''),
  customer_phone_snapshot text not null check (customer_phone_snapshot = btrim(customer_phone_snapshot) and customer_phone_snapshot <> ''),
  checkout_snapshot jsonb not null check (jsonb_typeof(checkout_snapshot) = 'object'),
  request_fingerprint text not null check (request_fingerprint = lower(btrim(request_fingerprint)) and request_fingerprint <> ''),
  gross_subtotal_snapshot numeric(14,2) not null check (gross_subtotal_snapshot >= 0),
  final_total_snapshot numeric(14,2) not null check (final_total_snapshot >= 0 and final_total_snapshot <= gross_subtotal_snapshot),
  initial_payment_snapshot numeric(14,2) not null check (initial_payment_snapshot >= 0 and initial_payment_snapshot <= final_total_snapshot),
  proposed_outstanding_credit numeric(14,2) not null check (proposed_outstanding_credit > 0),
  created_at timestamptz not null default now(),
  check (proposed_outstanding_credit = final_total_snapshot - initial_payment_snapshot)
);

create table public.sale_credit_decisions (
  id uuid primary key default gen_random_uuid(),
  sale_credit_request_id uuid not null unique references public.sale_credit_requests(id) on delete restrict,
  decision public.sale_approval_decision not null,
  decided_by uuid not null references public.profiles(id) on delete restrict,
  reason text check (reason is null or (reason = btrim(reason) and reason <> '')),
  created_at timestamptz not null default now()
);

alter table public.sales
  add constraint sales_discount_request_id_fkey
    foreign key (discount_request_id) references public.sale_discount_requests(id) on delete restrict,
  add constraint sales_credit_request_id_fkey
    foreign key (credit_request_id) references public.sale_credit_requests(id) on delete restrict;

create table public.sales_operation_reservations (
  request_id uuid primary key,
  operation public.sales_operation_kind not null,
  request_fingerprint text not null check (request_fingerprint = lower(btrim(request_fingerprint)) and request_fingerprint <> ''),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  completed_entity_type text check (completed_entity_type is null or (completed_entity_type = btrim(completed_entity_type) and completed_entity_type <> '')),
  completed_entity_id uuid,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (completed_at is null and completed_entity_type is null and completed_entity_id is null and result is null)
    or (completed_at is not null and completed_entity_type is not null and completed_entity_id is not null and result is not null)
  )
);

create table public.sales_settings (
  singleton boolean primary key default true check (singleton),
  manager_discount_max_percent numeric(5,2) not null default 0 check (manager_discount_max_percent between 0 and 100),
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);
insert into public.sales_settings (singleton, manager_discount_max_percent) values (true, 0);

-- Sales evidence is append-only. Settings remain mutable but their singleton
-- baseline must never be deleted.
create function public.forbid_sales_history_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'Immutable sales history cannot be changed or deleted';
end
$$;

create function public.forbid_sales_settings_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'The singleton sales settings row cannot be deleted';
end
$$;

-- The snapshot must be the customer identity at the time of finalization.
create function public.validate_sale_customer_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  customer_row public.customers;
begin
  if new.customer_id is not null then
    select * into customer_row from public.customers where id = new.customer_id for key share;
    if not found
       or new.customer_name_snapshot is distinct from customer_row.full_name
       or new.customer_phone_snapshot is distinct from customer_row.phone then
      raise exception 'Sale customer snapshot must match the selected customer at finalization';
    end if;
  end if;
  return new;
end
$$;

create function public.validate_sale_line_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  product_row public.products;
  variant_row public.product_variants;
begin
  select * into product_row from public.products where id = new.product_id for key share;
  if not found
     or product_row.name is distinct from new.product_name_snapshot
     or product_row.serialized is distinct from new.tracking_mode_snapshot then
    raise exception 'Sale line snapshots must match the selected product at finalization';
  end if;
  if new.variant_id is null then
    if new.variant_label_snapshot is not null then
      raise exception 'Base-product sale lines cannot carry a variant label snapshot';
    end if;
  else
    select * into variant_row from public.product_variants where id = new.variant_id for key share;
    if not found
       or variant_row.product_id is distinct from new.product_id
       or variant_row.label is distinct from new.variant_label_snapshot then
      raise exception 'Sale line variant snapshot must match the selected variant at finalization';
    end if;
  end if;
  return new;
end
$$;

create function public.validate_sale_credit_request_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  customer_row public.customers;
begin
  select * into customer_row from public.customers where id = new.customer_id for key share;
  if not found
     or customer_row.full_name is distinct from new.customer_name_snapshot
     or customer_row.phone is distinct from new.customer_phone_snapshot then
    raise exception 'Sale credit request customer snapshots must match the selected customer';
  end if;
  return new;
end
$$;

-- Serialized COGS and identifier evidence must correspond to the exact unit
-- selected for the serialized sale line while it is still sellable.
create function public.validate_sale_serialized_unit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  line_row public.sale_lines;
  unit_row public.serialized_units;
begin
  select * into line_row from public.sale_lines where id = new.sale_line_id for key share;
  if not found
     or line_row.sale_id is distinct from new.sale_id
     or not line_row.tracking_mode_snapshot
     or line_row.quantity < 1 then
    raise exception 'Serialized sale evidence must reference a serialized line in its exact sale';
  end if;

  select * into unit_row from public.serialized_units where id = new.serialized_unit_id for key share;
  if not found
     or unit_row.product_id is distinct from line_row.product_id
     or unit_row.variant_id is distinct from line_row.variant_id
     or unit_row.condition is distinct from line_row.condition
     or unit_row.status is distinct from 'AVAILABLE'
     or unit_row.acquisition_cost is distinct from new.acquisition_cost_snapshot then
    raise exception 'Serialized sale evidence must match an available unit exact identity and acquisition cost';
  end if;

  if not exists (
    select 1 from public.unit_identifiers ui
    where ui.unit_id = new.serialized_unit_id
      and ui.normalized_value = new.serialized_unit_identifier_snapshot
  ) then
    raise exception 'Serialized sale identifier snapshot must belong to the selected unit';
  end if;
  return new;
end
$$;

create function public.validate_sale_discount_decision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  request_row public.sale_discount_requests;
begin
  select * into request_row from public.sale_discount_requests where id = new.sale_discount_request_id for key share;
  if not found then
    raise exception 'Sale discount decision must reference an existing discount request';
  end if;
  if new.decision = 'APPROVED'
     and new.approved_discount_amount > request_row.requested_discount_amount then
    raise exception 'Approved sale discount cannot exceed the requested discount';
  end if;
  return new;
end
$$;

create function public.validate_sale_payment_reversal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  payment_row public.sale_payments;
  reversal_row public.sale_reversals;
begin
  select * into payment_row from public.sale_payments where id = new.sale_payment_id for key share;
  if not found then
    raise exception 'Sale payment reversal must reference an existing sale payment';
  end if;
  if new.sale_reversal_id is not null then
    select * into reversal_row from public.sale_reversals where id = new.sale_reversal_id for key share;
    if not found or reversal_row.sale_id is distinct from payment_row.sale_id then
      raise exception 'Sale payment reversal sale reversal must belong to the payment sale';
    end if;
  end if;
  return new;
end
$$;

create trigger validate_sale_customer_snapshot
before insert on public.sales
for each row execute function public.validate_sale_customer_snapshot();

create trigger validate_sale_line_snapshot
before insert on public.sale_lines
for each row execute function public.validate_sale_line_snapshot();

create trigger validate_sale_serialized_unit
before insert on public.sale_serialized_units
for each row execute function public.validate_sale_serialized_unit();

create trigger validate_sale_credit_request_snapshot
before insert on public.sale_credit_requests
for each row execute function public.validate_sale_credit_request_snapshot();

create trigger validate_sale_discount_decision
before insert on public.sale_discount_decisions
for each row execute function public.validate_sale_discount_decision();

create trigger validate_sale_payment_reversal
before insert on public.sale_payment_reversals
for each row execute function public.validate_sale_payment_reversal();

-- Phase 5/6 bucket and serialized-lifecycle evidence now recognize the two
-- sales operation types, while retaining every prior provenance branch.
-- Inventory movements retain their generic reference pair, but sales add
-- typed header/reversal provenance so a sales movement cannot impersonate a
-- legacy operation source.
alter table public.inventory_movements
  add column sale_id uuid references public.sales(id) on delete restrict,
  add column sale_reversal_id uuid references public.sale_reversals(id) on delete restrict,
  add constraint inventory_movements_sales_provenance_check check (
    (movement = 'SALE' and sale_id is not null and sale_reversal_id is null)
    or (movement = 'SALE_REVERSAL' and sale_id is not null and sale_reversal_id is not null)
    or (movement not in ('SALE', 'SALE_REVERSAL') and sale_id is null and sale_reversal_id is null)
  );

alter table public.inventory_bucket_effects
  add column sale_id uuid references public.sales(id) on delete restrict,
  add column sale_reversal_id uuid references public.sale_reversals(id) on delete restrict;

alter table public.inventory_bucket_effects
  drop constraint inventory_bucket_effects_check1,
  add constraint inventory_bucket_effects_check1 check (
    (movement in ('OPENING_STOCK', 'PURCHASE', 'SUPPLIER_RETURN_REVERSAL', 'SALE_REVERSAL') and quantity_after > quantity_before)
    or (movement in ('PURCHASE_REVERSAL', 'SUPPLIER_RETURN', 'SALE') and quantity_after < quantity_before)
    or (movement = 'ADJUSTMENT' and quantity_after <> quantity_before)
  ),
  drop constraint inventory_bucket_effects_check2,
  add constraint inventory_bucket_effects_check2 check (
    movement not in ('SUPPLIER_RETURN', 'SUPPLIER_RETURN_REVERSAL', 'SALE')
    or wac_after = wac_before
  ),
  drop constraint inventory_bucket_effects_check3,
  add constraint inventory_bucket_effects_check3 check (
    (movement = 'OPENING_STOCK'
      and opening_stock_batch_id is not null and inventory_adjustment_execution_id is null
      and purchase_id is null and purchase_reversal_id is null and supplier_return_id is null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'ADJUSTMENT'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is not null
      and purchase_id is null and purchase_reversal_id is null and supplier_return_id is null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'PURCHASE'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_reversal_id is null and supplier_return_id is null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'PURCHASE_REVERSAL'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_reversal_id is not null and supplier_return_id is null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'SUPPLIER_RETURN'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_reversal_id is null and supplier_return_id is not null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'SUPPLIER_RETURN_REVERSAL'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_reversal_id is null and supplier_return_id is not null and supplier_return_reversal_id is not null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'SALE'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is null and purchase_reversal_id is null and supplier_return_id is null and supplier_return_reversal_id is null
      and sale_id is not null and sale_reversal_id is null)
    or (movement = 'SALE_REVERSAL'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is null and purchase_reversal_id is null and supplier_return_id is null and supplier_return_reversal_id is null
      and sale_id is not null and sale_reversal_id is not null)
  );

create unique index inventory_bucket_effects_sale_source_bucket_key
  on public.inventory_bucket_effects(sale_id, stock_bucket_id) where movement = 'SALE';
create unique index inventory_bucket_effects_sale_reversal_source_bucket_key
  on public.inventory_bucket_effects(sale_reversal_id, stock_bucket_id) where movement = 'SALE_REVERSAL';

create or replace function public.validate_inventory_bucket_effect_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  bucket public.stock_buckets;
  purchase_reversal public.purchase_reversals;
  supplier_return public.supplier_returns;
  supplier_return_reversal public.supplier_return_reversals;
  adjustment_execution public.inventory_adjustment_executions;
  sale_reversal public.sale_reversals;
  original_sale_effect public.inventory_bucket_effects;
begin
  select * into bucket from public.stock_buckets where id = new.stock_bucket_id for key share;
  if not found
     or bucket.product_id <> new.product_id
     or bucket.variant_id is distinct from new.variant_id
     or bucket.condition is distinct from new.condition then
    raise exception 'Bucket effect must match its exact stock bucket identity';
  end if;
  if bucket.quantity is distinct from new.quantity_after
     or bucket.weighted_average_cost is distinct from new.wac_after
     or bucket.inventory_revision is distinct from new.revision_after then
    raise exception 'Bucket effect after-state must equal the authoritative current bucket state';
  end if;
  if new.movement = 'OPENING_STOCK' and not exists (
    select 1 from public.opening_stock_lines l
    where l.batch_id = new.opening_stock_batch_id
      and l.serialized = false
      and l.product_id = new.product_id
      and l.variant_id is not distinct from new.variant_id
      and l.condition = new.condition
  ) then
    raise exception 'Opening-stock bucket effect must reference a matching non-serialized opening-stock line';
  end if;
  if new.movement = 'ADJUSTMENT' then
    select * into adjustment_execution from public.inventory_adjustment_executions
    where id = new.inventory_adjustment_execution_id for key share;
    if not found
       or adjustment_execution.stock_bucket_id is distinct from new.stock_bucket_id
       or adjustment_execution.unit_id is not null
       or adjustment_execution.product_id is distinct from new.product_id
       or adjustment_execution.variant_id is distinct from new.variant_id
       or adjustment_execution.condition is distinct from new.condition
       or new.quantity_after - new.quantity_before is distinct from adjustment_execution.quantity
       or (adjustment_execution.quantity < 0 and new.wac_after is distinct from new.wac_before) then
      raise exception 'Adjustment bucket effect must reference its exact non-serialized adjustment execution';
    end if;
  end if;
  if new.purchase_reversal_id is not null then
    select * into purchase_reversal from public.purchase_reversals where id = new.purchase_reversal_id for key share;
    if not found or purchase_reversal.purchase_id is distinct from new.purchase_id then
      raise exception 'Purchase-reversal bucket effect must reference its purchase';
    end if;
  end if;
  if new.supplier_return_id is not null then
    select * into supplier_return from public.supplier_returns where id = new.supplier_return_id for key share;
    if not found or supplier_return.purchase_id is distinct from new.purchase_id then
      raise exception 'Supplier-return bucket effect must reference its purchase';
    end if;
  end if;
  if new.supplier_return_reversal_id is not null then
    select * into supplier_return_reversal from public.supplier_return_reversals where id = new.supplier_return_reversal_id for key share;
    if not found or supplier_return_reversal.supplier_return_id is distinct from new.supplier_return_id then
      raise exception 'Supplier-return-reversal bucket effect must reference its supplier return';
    end if;
  end if;
  if new.movement = 'SALE' and not exists (
    select 1 from public.sale_lines l
    where l.sale_id = new.sale_id
      and not l.tracking_mode_snapshot
      and l.product_id = new.product_id
      and l.variant_id is not distinct from new.variant_id
      and l.condition = new.condition
  ) then
    raise exception 'Sale bucket effect must reference a matching non-serialized sale line';
  end if;
  if new.movement = 'SALE_REVERSAL' then
    select * into sale_reversal from public.sale_reversals where id = new.sale_reversal_id for key share;
    if not found or sale_reversal.sale_id is distinct from new.sale_id then
      raise exception 'Sale-reversal bucket effect must reference its sale';
    end if;
    select * into original_sale_effect from public.inventory_bucket_effects
    where sale_id = new.sale_id and stock_bucket_id = new.stock_bucket_id and movement = 'SALE'
    for key share;
    if not found
       or new.quantity_after is distinct from original_sale_effect.quantity_before
       or new.wac_after is distinct from original_sale_effect.wac_before then
      raise exception 'Sale reversal must restore the original sale bucket quantity and weighted average cost';
    end if;
    if not exists (
      select 1 from public.sale_lines l
      where l.sale_id = new.sale_id
        and not l.tracking_mode_snapshot
        and l.product_id = new.product_id
        and l.variant_id is not distinct from new.variant_id
        and l.condition = new.condition
    ) then
      raise exception 'Sale-reversal bucket effect must reference a matching original non-serialized sale line';
    end if;
  end if;
  return new;
end
$$;

create or replace function public.validate_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  unit public.serialized_units;
  bucket public.stock_buckets;
  effect public.inventory_bucket_effects;
  sale_reversal public.sale_reversals;
begin
  if new.movement = 'SALE' then
    if new.reference_type <> 'SALE' or new.reference_id is distinct from new.sale_id then
      raise exception 'Sale inventory movement must reference its sale';
    end if;
  elsif new.movement = 'SALE_REVERSAL' then
    select * into sale_reversal from public.sale_reversals where id = new.sale_reversal_id for key share;
    if not found
       or sale_reversal.sale_id is distinct from new.sale_id
       or new.reference_type <> 'SALE_REVERSAL'
       or new.reference_id is distinct from new.sale_reversal_id then
      raise exception 'Sale-reversal inventory movement must reference its exact sale reversal';
    end if;
  end if;

  if new.unit_id is not null then
    select * into unit from public.serialized_units where id = new.unit_id;
    if not found or unit.product_id <> new.product_id or unit.variant_id is distinct from new.variant_id then
      raise exception 'Unit must match movement product and variant';
    end if;
    if new.bucket_effect_id is not null then
      raise exception 'Serialized inventory movements cannot reference a bucket effect';
    end if;
  else
    select * into bucket from public.stock_buckets where id = new.stock_bucket_id;
    if not found or bucket.product_id <> new.product_id or bucket.variant_id is distinct from new.variant_id then
      raise exception 'Stock bucket must match movement product and variant';
    end if;
    if new.movement in ('SALE', 'SALE_REVERSAL') and new.bucket_effect_id is null then
      raise exception 'Non-serialized sales inventory movements must reference their bucket effect';
    end if;
    if new.bucket_effect_id is not null then
      select * into effect from public.inventory_bucket_effects where id = new.bucket_effect_id;
      if not found
         or effect.stock_bucket_id <> new.stock_bucket_id
         or effect.movement <> new.movement
         or effect.product_id <> new.product_id
         or effect.variant_id is distinct from new.variant_id
         or effect.condition is distinct from new.condition_after
         or (new.movement = 'SALE' and (
           effect.sale_id is distinct from new.sale_id or effect.sale_reversal_id is not null
         ))
         or (new.movement = 'SALE_REVERSAL' and (
           effect.sale_id is distinct from new.sale_id or effect.sale_reversal_id is distinct from new.sale_reversal_id
         )) then
        raise exception 'Movement bucket_effect_id must match its bucket and typed operation';
      end if;
    end if;
  end if;
  return new;
end
$$;

alter table public.serialized_unit_lifecycle_effects
  add column sale_id uuid references public.sales(id) on delete restrict,
  add column sale_reversal_id uuid references public.sale_reversals(id) on delete restrict;

alter table public.serialized_unit_lifecycle_effects
  drop constraint serialized_unit_lifecycle_effects_check2,
  add constraint serialized_unit_lifecycle_effects_check2 check (
    (movement = 'OPENING_STOCK'
      and opening_stock_line_id is not null and inventory_adjustment_execution_id is null
      and purchase_id is null and purchase_item_id is null and purchase_reversal_id is null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'ADJUSTMENT'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is not null
      and purchase_id is null and purchase_item_id is null and purchase_reversal_id is null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'PURCHASE'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_item_id is not null and purchase_reversal_id is null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'PURCHASE_REVERSAL'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_item_id is not null and purchase_reversal_id is not null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'SUPPLIER_RETURN'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_item_id is not null and purchase_reversal_id is null
      and supplier_return_id is not null and supplier_return_line_id is not null and supplier_return_reversal_id is null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'SUPPLIER_RETURN_REVERSAL'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_item_id is not null and purchase_reversal_id is null
      and supplier_return_id is not null and supplier_return_line_id is not null and supplier_return_reversal_id is not null
      and sale_id is null and sale_reversal_id is null)
    or (movement = 'SALE'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is null and purchase_item_id is null and purchase_reversal_id is null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null
      and sale_id is not null and sale_reversal_id is null)
    or (movement = 'SALE_REVERSAL'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is null and purchase_item_id is null and purchase_reversal_id is null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null
      and sale_id is not null and sale_reversal_id is not null)
  );

create index serialized_unit_lifecycle_effects_sale_id_idx
  on public.serialized_unit_lifecycle_effects(sale_id) where sale_id is not null;
create index serialized_unit_lifecycle_effects_sale_reversal_id_idx
  on public.serialized_unit_lifecycle_effects(sale_reversal_id) where sale_reversal_id is not null;
create unique index serialized_unit_lifecycle_effects_sale_unit_key
  on public.serialized_unit_lifecycle_effects(sale_id, unit_id) where movement = 'SALE';
create unique index serialized_unit_lifecycle_effects_sale_reversal_unit_key
  on public.serialized_unit_lifecycle_effects(sale_reversal_id, unit_id) where movement = 'SALE_REVERSAL';

create or replace function public.validate_serialized_lifecycle_effect()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  movement_row public.inventory_movements;
  unit_row public.serialized_units;
  opening_line public.opening_stock_lines;
  adjustment_execution public.inventory_adjustment_executions;
  item public.purchase_items;
  return_line public.supplier_return_lines;
  purchase_reversal public.purchase_reversals;
  supplier_return_reversal public.supplier_return_reversals;
  sale_reversal public.sale_reversals;
  original_sale_effect public.serialized_unit_lifecycle_effects;
begin
  select * into movement_row from public.inventory_movements where id = new.movement_id for key share;
  if not found
     or movement_row.unit_id is distinct from new.unit_id
     or movement_row.movement <> new.movement
     or movement_row.condition_before is distinct from new.condition_before
     or movement_row.condition_after is distinct from new.condition_after
     or movement_row.sale_id is distinct from new.sale_id
     or movement_row.sale_reversal_id is distinct from new.sale_reversal_id then
    raise exception 'Serialized lifecycle effect must match its immutable serialized movement';
  end if;
  select * into unit_row from public.serialized_units where id = new.unit_id for key share;
  if not found
     or unit_row.status is distinct from new.status_after
     or unit_row.condition is distinct from new.condition_after
     or unit_row.lifecycle_revision is distinct from new.unit_revision_after then
    raise exception 'Serialized lifecycle effect after-state must equal the authoritative current unit state';
  end if;
  if (new.movement in ('OPENING_STOCK', 'PURCHASE')
      and (new.status_before is distinct from null or new.status_after is distinct from 'AVAILABLE' or movement_row.quantity <> 1
        or new.unit_revision_before <> 0 or new.unit_revision_after <> 1))
     or (new.movement = 'ADJUSTMENT'
      and (new.status_before is distinct from 'AVAILABLE' or new.status_after is distinct from 'ADJUSTED_OUT' or movement_row.quantity <> -1))
     or (new.movement = 'PURCHASE_REVERSAL'
      and (new.status_before is distinct from 'AVAILABLE' or new.status_after is distinct from 'PURCHASE_REVERSED' or movement_row.quantity <> -1))
     or (new.movement = 'SUPPLIER_RETURN'
      and (new.status_before is distinct from 'AVAILABLE' or new.status_after is distinct from 'RETURNED_TO_SUPPLIER' or movement_row.quantity <> -1))
     or (new.movement = 'SUPPLIER_RETURN_REVERSAL'
      and (new.status_before is distinct from 'RETURNED_TO_SUPPLIER' or new.status_after is distinct from 'AVAILABLE' or movement_row.quantity <> 1))
     or (new.movement = 'SALE'
      and (new.status_before is distinct from 'AVAILABLE' or new.status_after is distinct from 'SOLD' or movement_row.quantity <> -1))
     or (new.movement = 'SALE_REVERSAL'
      and (new.status_before is distinct from 'SOLD' or new.status_after is distinct from 'AVAILABLE' or movement_row.quantity <> 1)) then
    raise exception 'Serialized lifecycle effect has an invalid typed transition';
  end if;
  if new.movement not in ('OPENING_STOCK', 'PURCHASE')
     and (new.condition_before is null or new.condition_before is distinct from new.condition_after) then
    raise exception 'Serialized lifecycle non-creation transitions must preserve a non-null condition';
  end if;
  if new.movement = 'OPENING_STOCK' then
    select * into opening_line from public.opening_stock_lines where id = new.opening_stock_line_id for key share;
    if not found
       or unit_row.opening_stock_line_id is distinct from new.opening_stock_line_id
       or opening_line.product_id is distinct from unit_row.product_id
       or opening_line.variant_id is distinct from unit_row.variant_id
       or opening_line.condition is distinct from new.condition_after then
      raise exception 'Opening-stock lifecycle effect must reference the unit exact opening-stock source';
    end if;
  end if;
  if new.movement = 'ADJUSTMENT' then
    select * into adjustment_execution from public.inventory_adjustment_executions
    where id = new.inventory_adjustment_execution_id for key share;
    if not found
       or adjustment_execution.unit_id is distinct from new.unit_id
       or adjustment_execution.product_id is distinct from unit_row.product_id
       or adjustment_execution.variant_id is distinct from unit_row.variant_id
       or adjustment_execution.condition is distinct from new.condition_after
       or adjustment_execution.quantity <> -1 then
      raise exception 'Adjustment lifecycle effect must reference its exact serialized adjustment execution';
    end if;
  end if;
  if new.purchase_item_id is not null then
    select * into item from public.purchase_items where id = new.purchase_item_id for key share;
    if not found or item.purchase_id is distinct from new.purchase_id then
      raise exception 'Serialized lifecycle purchase item must belong to its purchase';
    end if;
    if new.movement in ('PURCHASE', 'PURCHASE_REVERSAL') and (
      unit_row.purchase_item_id is distinct from new.purchase_item_id
      or item.product_id is distinct from unit_row.product_id
      or item.variant_id is distinct from unit_row.variant_id
      or item.condition is distinct from new.condition_after
    ) then
      raise exception 'Purchase lifecycle effect must reference the unit exact purchase-item source';
    end if;
  end if;
  if new.supplier_return_line_id is not null then
    select * into return_line from public.supplier_return_lines where id = new.supplier_return_line_id for key share;
    if not found
       or return_line.supplier_return_id is distinct from new.supplier_return_id
       or return_line.purchase_item_id is distinct from new.purchase_item_id
       or return_line.serialized_unit_id is distinct from new.unit_id then
      raise exception 'Serialized lifecycle supplier-return source is inconsistent';
    end if;
  end if;
  if new.purchase_reversal_id is not null then
    select * into purchase_reversal from public.purchase_reversals where id = new.purchase_reversal_id for key share;
    if not found or purchase_reversal.purchase_id is distinct from new.purchase_id then
      raise exception 'Serialized lifecycle purchase reversal must reference its purchase';
    end if;
  end if;
  if new.supplier_return_reversal_id is not null then
    select * into supplier_return_reversal from public.supplier_return_reversals
    where id = new.supplier_return_reversal_id for key share;
    if not found or supplier_return_reversal.supplier_return_id is distinct from new.supplier_return_id then
      raise exception 'Serialized lifecycle supplier-return reversal must reference its supplier return';
    end if;
  end if;
  if new.movement = 'SALE' and not exists (
    select 1 from public.sale_serialized_units ssu
    where ssu.sale_id = new.sale_id and ssu.serialized_unit_id = new.unit_id
  ) then
    raise exception 'Sale lifecycle effect must reference serialized sale evidence for its exact unit';
  end if;
  if new.movement = 'SALE_REVERSAL' then
    select * into sale_reversal from public.sale_reversals where id = new.sale_reversal_id for key share;
    if not found or sale_reversal.sale_id is distinct from new.sale_id then
      raise exception 'Sale-reversal lifecycle effect must reference its sale';
    end if;
    if not exists (
      select 1 from public.sale_serialized_units ssu
      where ssu.sale_id = new.sale_id and ssu.serialized_unit_id = new.unit_id
    ) then
      raise exception 'Sale-reversal lifecycle effect must reference original serialized sale evidence';
    end if;
    select * into original_sale_effect from public.serialized_unit_lifecycle_effects
    where sale_id = new.sale_id and unit_id = new.unit_id and movement = 'SALE'
    for key share;
    if not found or new.unit_revision_before is distinct from original_sale_effect.unit_revision_after then
      raise exception 'Sale reversal must continue from the original sale unit lifecycle revision';
    end if;
  end if;
  return new;
end
$$;

create trigger immutable_sales before update or delete on public.sales
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_lines before update or delete on public.sale_lines
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_serialized_units before update or delete on public.sale_serialized_units
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_payments before update or delete on public.sale_payments
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_payment_reversals before update or delete on public.sale_payment_reversals
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_discount_requests before update or delete on public.sale_discount_requests
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_discount_decisions before update or delete on public.sale_discount_decisions
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_credit_requests before update or delete on public.sale_credit_requests
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_credit_decisions before update or delete on public.sale_credit_decisions
for each row execute function public.forbid_sales_history_mutation();
create trigger immutable_sale_reversals before update or delete on public.sale_reversals
for each row execute function public.forbid_sales_history_mutation();
create trigger protect_sales_settings_delete before delete on public.sales_settings
for each row execute function public.forbid_sales_settings_delete();
create trigger sales_settings_updated before update on public.sales_settings
for each row execute function public.touch_updated_at();

-- Derived financial state is intentionally computed from immutable events.
create view public.sale_financial_summary
with (security_invoker = true)
as
with active_payments as (
  select sp.sale_id, coalesce(sum(sp.amount), 0)::numeric(14,2) as active_payment_total
  from public.sale_payments sp
  left join public.sale_payment_reversals spr on spr.sale_payment_id = sp.id
  where spr.id is null
  group by sp.sale_id
)
select
  s.id as sale_id,
  s.customer_id,
  s.sale_number,
  s.sale_kind,
  s.transaction_on,
  case when sr.id is null then 'ACTIVE' else 'REVERSED' end as sale_state,
  s.gross_subtotal,
  s.discount_total,
  s.final_total,
  coalesce(ap.active_payment_total, 0)::numeric(14,2) as active_payment_total,
  greatest(s.final_total - coalesce(ap.active_payment_total, 0), 0)::numeric(14,2) as outstanding_amount,
  case
    when sr.id is not null or s.sale_kind = 'ORDINARY' then 'NOT_APPLICABLE'
    when greatest(s.final_total - coalesce(ap.active_payment_total, 0), 0) > 0 then 'OUTSTANDING'
    else 'PAID'
  end as credit_state
from public.sales s
left join public.sale_reversals sr on sr.sale_id = s.id
left join active_payments ap on ap.sale_id = s.id;

create index sales_customer_transaction_idx on public.sales(customer_id, transaction_on desc) where customer_id is not null;
create index sales_finalized_by_created_idx on public.sales(finalized_by, created_at desc);
create index sale_lines_sale_id_idx on public.sale_lines(sale_id, line_number);
create index sale_lines_product_variant_idx on public.sale_lines(product_id, variant_id);
create index sale_serialized_units_unit_idx on public.sale_serialized_units(serialized_unit_id);
create index sale_payments_sale_paid_on_idx on public.sale_payments(sale_id, paid_on desc);
create index sale_payment_reversals_sale_reversal_idx on public.sale_payment_reversals(sale_reversal_id) where sale_reversal_id is not null;
create index sale_discount_requests_requested_created_idx on public.sale_discount_requests(requested_by, created_at desc);
create index sale_credit_requests_customer_created_idx on public.sale_credit_requests(customer_id, created_at desc);
create index sales_operation_reservations_actor_created_idx on public.sales_operation_reservations(actor_id, created_at desc);

-- No browser-side transactional writes. Management gets read-only access;
-- reservations intentionally have no browser policy or grant.
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.sale_serialized_units enable row level security;
alter table public.sale_payments enable row level security;
alter table public.sale_payment_reversals enable row level security;
alter table public.sale_discount_requests enable row level security;
alter table public.sale_discount_decisions enable row level security;
alter table public.sale_credit_requests enable row level security;
alter table public.sale_credit_decisions enable row level security;
alter table public.sale_reversals enable row level security;
alter table public.sales_operation_reservations enable row level security;
alter table public.sales_settings enable row level security;

create policy "management read sales" on public.sales for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sale lines" on public.sale_lines for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read serialized sale evidence" on public.sale_serialized_units for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sale payments" on public.sale_payments for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sale payment reversals" on public.sale_payment_reversals for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sale discount requests" on public.sale_discount_requests for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sale discount decisions" on public.sale_discount_decisions for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sale credit requests" on public.sale_credit_requests for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sale credit decisions" on public.sale_credit_decisions for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sale reversals" on public.sale_reversals for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read sales settings" on public.sales_settings for select using (public.current_role() in ('ADMIN', 'MANAGER'));

revoke all on table public.sales, public.sale_lines, public.sale_serialized_units, public.sale_payments, public.sale_payment_reversals, public.sale_discount_requests, public.sale_discount_decisions, public.sale_credit_requests, public.sale_credit_decisions, public.sale_reversals, public.sales_operation_reservations, public.sales_settings from public, anon, authenticated;
grant select on table public.sales, public.sale_lines, public.sale_serialized_units, public.sale_payments, public.sale_payment_reversals, public.sale_discount_requests, public.sale_discount_decisions, public.sale_credit_requests, public.sale_credit_decisions, public.sale_reversals, public.sales_settings to authenticated;
revoke all on table public.sale_financial_summary from public, anon, authenticated;
grant select on table public.sale_financial_summary to authenticated;

revoke all on function public.forbid_sales_history_mutation(), public.forbid_sales_settings_delete(), public.validate_sale_customer_snapshot(), public.validate_sale_line_snapshot(), public.validate_sale_credit_request_snapshot(), public.validate_sale_serialized_unit(), public.validate_sale_discount_decision(), public.validate_sale_payment_reversal(), public.validate_inventory_bucket_effect_identity(), public.validate_serialized_lifecycle_effect() from public, anon, authenticated;

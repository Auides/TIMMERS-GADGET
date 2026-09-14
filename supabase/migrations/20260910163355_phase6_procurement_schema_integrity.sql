-- Phase 6 Migration 2: procurement schema, declarative integrity, history and RLS.
-- No user-facing procurement transaction RPC is defined in this migration.

-- Fail closed before changing legacy purchase semantics. These checks deliberately
-- refuse to invent payment, condition, supplier-name, or serialized-cost history.
do $$
begin
  if exists (select 1 from public.purchases where amount_paid <> 0) then
    raise exception 'Phase 6 migration blocked: legacy purchases.amount_paid contains non-zero values';
  end if;
  if exists (select 1 from public.purchases) then
    raise exception 'Phase 6 migration blocked: legacy purchases lack immutable historical supplier-name snapshots';
  end if;
  if exists (
    select 1
    from public.purchase_items pi
    left join public.products p on p.id = pi.product_id
    left join public.serialized_units u on u.purchase_item_id = pi.id
    group by pi.id, pi.quantity, p.serialized
    having p.serialized is distinct from true
       or count(u.id) <> pi.quantity
       or count(distinct u.condition) <> 1
  ) then
    raise exception 'Phase 6 migration blocked: legacy purchase-item condition provenance is not provable';
  end if;
  if exists (
    select 1
    from public.serialized_units u
    left join public.purchase_items pi on pi.id = u.purchase_item_id
    left join public.products p on p.id = u.product_id
    where u.purchase_item_id is not null
      and (
        not ((u.purchase_item_id is not null) <> (u.opening_stock_line_id is not null))
        or pi.id is null
        or u.product_id is distinct from pi.product_id
        or u.variant_id is distinct from pi.variant_id
        or p.serialized is distinct from true
        or u.acquisition_cost is distinct from pi.unit_cost
        or (select count(*) from public.serialized_units x where x.purchase_item_id = u.purchase_item_id) > pi.quantity
      )
  ) then
    raise exception 'Phase 6 migration blocked: legacy serialized purchase-origin integrity failed';
  end if;
  if exists (
    select 1
    from public.serialized_units u
    left join public.opening_stock_lines l on l.id = u.opening_stock_line_id
    left join public.products p on p.id = u.product_id
    where u.opening_stock_line_id is not null
      and (
        not ((u.purchase_item_id is not null) <> (u.opening_stock_line_id is not null))
        or l.id is null
        or l.serialized is distinct from true
        or u.product_id is distinct from l.product_id
        or u.variant_id is distinct from l.variant_id
        or p.serialized is distinct from true
        or u.acquisition_cost is distinct from l.unit_cost
        or u.condition is distinct from l.condition
        or u.warranty_start is distinct from l.warranty_start
        or u.warranty_expiry is distinct from l.warranty_expiry
      )
  ) then
    raise exception 'Phase 6 migration blocked: opening-stock serialized-origin integrity failed';
  end if;
  if exists (
    select 1
    from public.purchases p
    left join public.purchase_items pi on pi.purchase_id = p.id
    group by p.id, p.total
    having p.total is distinct from coalesce(sum(pi.quantity * pi.unit_cost), 0)::numeric(14,2)
  ) then
    raise exception 'Phase 6 migration blocked: legacy purchase totals are inconsistent';
  end if;
  if exists (
    select 1 from public.purchases
    where purchased_on is null
       or purchased_on > (current_timestamp at time zone 'Africa/Lagos')::date
  ) then
    raise exception 'Phase 6 migration blocked: legacy purchase dates are null or future';
  end if;
end
$$;

-- Suppliers retain their current identity details and gain archive state only.
alter table public.suppliers
  add column active boolean not null default true,
  add column archived_at timestamptz,
  add column archived_by uuid references public.profiles(id) on delete restrict,
  add constraint suppliers_archive_state_check check (
    (active and archived_at is null and archived_by is null)
    or (not active and archived_at is not null and archived_by is not null)
  );

create function public.forbid_supplier_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'Suppliers are archived; hard deletion is prohibited';
end
$$;

create trigger no_delete_suppliers
before delete on public.suppliers
for each row execute function public.forbid_supplier_delete();

-- Purchase numbers are technical system identifiers, never supplier documentation.
create sequence public.purchase_number_seq as bigint start with 1 increment by 1 no cycle;
alter table public.purchases
  rename column purchased_on to received_on;
alter table public.purchases
  rename column reference to supplier_reference;
alter table public.purchases
  drop constraint purchases_reference_key,
  drop column amount_paid,
  drop column updated_at,
  add column purchase_number bigint not null default nextval('public.purchase_number_seq'::regclass),
  add column supplier_name_snapshot text not null check (
    supplier_name_snapshot = btrim(supplier_name_snapshot)
    and supplier_name_snapshot <> ''
  ),
  add column notes text check (notes is null or (notes = btrim(notes) and notes <> '')),
  add constraint purchases_purchase_number_key unique (purchase_number);
alter sequence public.purchase_number_seq owned by public.purchases.purchase_number;
drop trigger purchases_updated on public.purchases;
drop index public.purchases_purchased_on_idx;
create index purchases_supplier_received_on_idx on public.purchases(supplier_id, received_on desc);

alter table public.purchase_items
  alter column unit_cost drop not null,
  add column line_number integer not null check (line_number > 0),
  add column condition public.product_condition not null,
  add column notes text check (notes is null or (notes = btrim(notes) and notes <> '')),
  add constraint purchase_items_purchase_line_number_key unique (purchase_id, line_number);
create index purchase_items_product_variant_condition_idx
  on public.purchase_items(product_id, variant_id, condition);

-- Existing serialized purchase-origin rows were checked above. New Phase 6
-- serialized line costs are intentionally non-authoritative; their exact unit
-- acquisition costs live only on serialized_units.
create or replace function public.validate_serialized_purchase_origin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  item public.purchase_items;
  opening_line public.opening_stock_lines;
  product_is_serialized boolean;
  linked_unit_count integer;
begin
  select p.serialized into product_is_serialized
  from public.products p
  where p.id = new.product_id;
  if product_is_serialized is distinct from true then
    raise exception 'Serialized units may reference only serialized products';
  end if;
  if num_nonnulls(new.purchase_item_id, new.opening_stock_line_id) <> 1 then
    raise exception 'A serialized unit requires exactly one acquisition origin';
  end if;

  if new.purchase_item_id is not null then
    select * into item from public.purchase_items where id = new.purchase_item_id for update;
    if not found
       or item.product_id <> new.product_id
       or item.variant_id is distinct from new.variant_id then
      raise exception 'Serialized unit purchase origin must match its product and variant';
    end if;
    if tg_op = 'INSERT' and new.condition is distinct from item.condition then
      raise exception 'Serialized unit condition must match its purchase item condition';
    end if;
    if tg_op = 'INSERT' then
      select count(*) into linked_unit_count
      from public.serialized_units
      where purchase_item_id = new.purchase_item_id;
      if linked_unit_count >= item.quantity then
        raise exception 'Serialized unit count cannot exceed the purchase item quantity';
      end if;
    end if;
  else
    select * into opening_line
    from public.opening_stock_lines
    where id = new.opening_stock_line_id
    for key share;
    if not found or not opening_line.serialized
       or opening_line.product_id <> new.product_id
       or opening_line.variant_id is distinct from new.variant_id then
      raise exception 'Serialized opening stock origin must match its product and variant';
    end if;
    if new.acquisition_cost is distinct from opening_line.unit_cost then
      raise exception 'Serialized acquisition cost must equal its opening stock cost';
    end if;
    if tg_op = 'INSERT' and new.condition is distinct from opening_line.condition then
      raise exception 'Serialized opening stock condition must match its opening stock origin';
    end if;
    if tg_op = 'INSERT' and (
      new.warranty_start is distinct from opening_line.warranty_start
      or new.warranty_expiry is distinct from opening_line.warranty_expiry
    ) then
      raise exception 'Serialized opening stock warranty data must match its opening stock origin';
    end if;
    if tg_op = 'INSERT' then
      select count(*) into linked_unit_count
      from public.serialized_units
      where opening_stock_line_id = new.opening_stock_line_id;
      if linked_unit_count >= opening_line.quantity then
        raise exception 'Serialized unit count cannot exceed the opening stock line quantity';
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.purchase_item_id is distinct from old.purchase_item_id
    or new.opening_stock_line_id is distinct from old.opening_stock_line_id
    or new.acquisition_cost is distinct from old.acquisition_cost
  ) then
    raise exception 'Serialized acquisition origin and cost are immutable';
  end if;
  if tg_op = 'UPDATE' and (
    new.warranty_start is distinct from old.warranty_start
    or new.warranty_expiry is distinct from old.warranty_expiry
  ) then
    raise exception 'Serialized warranty history requires a separate audited correction workflow';
  end if;
  return new;
end
$$;

alter table public.stock_buckets
  add column inventory_revision bigint not null default 0,
  add constraint stock_buckets_inventory_revision_nonnegative check (inventory_revision >= 0);

alter table public.serialized_units
  add column lifecycle_revision bigint not null default 0,
  add constraint serialized_units_lifecycle_revision_nonnegative check (lifecycle_revision >= 0);

create function public.enforce_stock_bucket_revision()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.quantity is distinct from old.quantity
     or new.weighted_average_cost is distinct from old.weighted_average_cost then
    if new.inventory_revision <> old.inventory_revision + 1 then
      raise exception 'Stock-affecting bucket changes must advance inventory_revision exactly once';
    end if;
  elsif new.inventory_revision is distinct from old.inventory_revision then
    raise exception 'inventory_revision may change only with a stock-affecting bucket change';
  end if;
  return new;
end
$$;

create function public.enforce_serialized_lifecycle_revision()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status in ('PURCHASE_REVERSED', 'ADJUSTED_OUT')
     and new.status is distinct from old.status then
    raise exception 'This serialized-unit terminal status requires a separate approved workflow';
  end if;
  if old.status = 'RETURNED_TO_SUPPLIER'
     and new.status is distinct from old.status
     and new.status <> 'AVAILABLE' then
    raise exception 'A returned-to-supplier unit may only be restored through its approved reversal workflow';
  end if;
  if new.status is distinct from old.status
     or new.condition is distinct from old.condition then
    if new.lifecycle_revision <> old.lifecycle_revision + 1 then
      raise exception 'Serialized lifecycle changes must advance lifecycle_revision exactly once';
    end if;
  elsif new.lifecycle_revision is distinct from old.lifecycle_revision then
    raise exception 'lifecycle_revision may change only with a serialized lifecycle change';
  end if;
  return new;
end
$$;
-- These revision-enforcement functions are deliberately not attached in
-- Migration 2. The deployed Phase 5 RPCs are not revision-aware; Migration 3
-- will recreate them and activate the triggers atomically with that work.

-- Immutable procurement records and audit evidence share one consistent guard.
create function public.forbid_procurement_history_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'Immutable procurement and audit history cannot be changed or deleted';
end
$$;

create table public.purchase_reversals (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.purchases(id) on delete restrict,
  reason text not null check (reason = btrim(reason) and reason <> ''),
  reversed_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  method public.supplier_payment_method not null,
  paid_on date not null,
  reference text check (reference is null or (reference = btrim(reference) and reference <> '')),
  notes text check (notes is null or (notes = btrim(notes) and notes <> '')),
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.supplier_payment_reversals (
  id uuid primary key default gen_random_uuid(),
  supplier_payment_id uuid not null unique references public.supplier_payments(id) on delete restrict,
  purchase_reversal_id uuid references public.purchase_reversals(id) on delete restrict,
  reason text not null check (reason = btrim(reason) and reason <> ''),
  reversed_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create sequence public.supplier_return_number_seq as bigint start with 1 increment by 1 no cycle;
create table public.supplier_returns (
  id uuid primary key default gen_random_uuid(),
  return_number bigint not null default nextval('public.supplier_return_number_seq'::regclass),
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  return_order bigint not null check (return_order > 0),
  supplier_reference text check (supplier_reference is null or (supplier_reference = btrim(supplier_reference) and supplier_reference <> '')),
  returned_on date not null,
  reason text not null check (reason = btrim(reason) and reason <> ''),
  total numeric(14,2) not null check (total >= 0),
  completed_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (return_number),
  unique (purchase_id, return_order)
);
alter sequence public.supplier_return_number_seq owned by public.supplier_returns.return_number;

create table public.supplier_return_lines (
  id uuid primary key default gen_random_uuid(),
  supplier_return_id uuid not null references public.supplier_returns(id) on delete restrict,
  purchase_item_id uuid not null references public.purchase_items(id) on delete restrict,
  serialized_unit_id uuid references public.serialized_units(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  source_unit_cost numeric(14,2) not null check (source_unit_cost >= 0),
  return_value numeric(14,2) not null check (return_value >= 0),
  created_at timestamptz not null default now(),
  check (serialized_unit_id is null or quantity = 1),
  check (return_value = quantity * source_unit_cost)
);

create table public.supplier_return_reversals (
  id uuid primary key default gen_random_uuid(),
  supplier_return_id uuid not null unique references public.supplier_returns(id) on delete restrict,
  reason text not null check (reason = btrim(reason) and reason <> ''),
  reversed_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create function public.validate_supplier_payment_reversal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  payment public.supplier_payments;
  purchase_reversal public.purchase_reversals;
begin
  select * into payment
  from public.supplier_payments
  where id = new.supplier_payment_id
  for key share;
  if not found then
    raise exception 'Supplier payment reversal must reference an existing supplier payment';
  end if;

  if new.purchase_reversal_id is not null then
    select * into purchase_reversal
    from public.purchase_reversals
    where id = new.purchase_reversal_id
    for key share;
    if not found
       or purchase_reversal.purchase_id is distinct from payment.purchase_id then
      raise exception 'Supplier payment reversal purchase reversal must belong to the supplier payment purchase';
    end if;
  end if;

  return new;
end
$$;
create trigger validate_supplier_payment_reversal
before insert on public.supplier_payment_reversals
for each row execute function public.validate_supplier_payment_reversal();

create function public.validate_supplier_return_line()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  supplier_return public.supplier_returns;
  item public.purchase_items;
  product_row public.products;
  unit_row public.serialized_units;
begin
  select * into supplier_return
  from public.supplier_returns
  where id = new.supplier_return_id
  for key share;
  if not found then
    raise exception 'Supplier return line must reference an existing supplier return';
  end if;

  select * into item
  from public.purchase_items
  where id = new.purchase_item_id
  for key share;
  if not found
     or item.purchase_id is distinct from supplier_return.purchase_id then
    raise exception 'Supplier return line purchase item must belong to the supplier return purchase';
  end if;

  select * into product_row
  from public.products
  where id = item.product_id
  for key share;
  if not found then
    raise exception 'Supplier return line purchase item must reference an existing product';
  end if;

  if product_row.serialized then
    if new.serialized_unit_id is null or new.quantity <> 1 then
      raise exception 'Serialized supplier return lines require one serialized unit';
    end if;

    select * into unit_row
    from public.serialized_units
    where id = new.serialized_unit_id
    for update;
    if not found
       or unit_row.purchase_item_id is distinct from new.purchase_item_id
       or unit_row.product_id is distinct from item.product_id
       or unit_row.variant_id is distinct from item.variant_id
       or unit_row.status is distinct from 'AVAILABLE'
       or new.source_unit_cost is distinct from unit_row.acquisition_cost then
      raise exception 'Serialized supplier return line must match the available unit exact purchase origin and acquisition cost';
    end if;

    if exists (
      select 1
      from public.supplier_return_lines active_line
      join public.supplier_returns active_return
        on active_return.id = active_line.supplier_return_id
      left join public.supplier_return_reversals active_reversal
        on active_reversal.supplier_return_id = active_return.id
      where active_line.serialized_unit_id = new.serialized_unit_id
        and active_reversal.id is null
    ) then
      raise exception 'Serialized unit already belongs to an active supplier return';
    end if;
  elsif new.serialized_unit_id is not null
     or item.unit_cost is null
     or new.source_unit_cost is distinct from item.unit_cost then
    raise exception 'Non-serialized supplier return line must use its purchase-item source cost and cannot reference a serialized unit';
  end if;

  return new;
end
$$;
create trigger validate_supplier_return_line
before insert on public.supplier_return_lines
for each row execute function public.validate_supplier_return_line();

create table public.supplier_refund_receipts (
  id uuid primary key default gen_random_uuid(),
  supplier_return_id uuid not null references public.supplier_returns(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  method public.supplier_payment_method not null,
  received_on date not null,
  reference text check (reference is null or (reference = btrim(reference) and reference <> '')),
  notes text check (notes is null or (notes = btrim(notes) and notes <> '')),
  received_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.supplier_refund_receipt_reversals (
  id uuid primary key default gen_random_uuid(),
  supplier_refund_receipt_id uuid not null unique references public.supplier_refund_receipts(id) on delete restrict,
  reason text not null check (reason = btrim(reason) and reason <> ''),
  reversed_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

-- One immutable bucket effect records the single aggregate physical mutation
-- for an exact bucket and operation. Individual movements may share it.
create table public.inventory_bucket_effects (
  id uuid primary key default gen_random_uuid(),
  movement public.movement_type not null,
  stock_bucket_id uuid not null references public.stock_buckets(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  variant_id uuid,
  condition public.product_condition not null,
  quantity_before integer not null check (quantity_before >= 0),
  quantity_after integer not null check (quantity_after >= 0),
  wac_before numeric(14,2) not null check (wac_before >= 0),
  wac_after numeric(14,2) not null check (wac_after >= 0),
  revision_before bigint not null check (revision_before >= 0),
  revision_after bigint not null check (revision_after = revision_before + 1),
  opening_stock_batch_id uuid references public.opening_stock_batches(id) on delete restrict,
  inventory_adjustment_execution_id uuid references public.inventory_adjustment_executions(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete restrict,
  purchase_reversal_id uuid references public.purchase_reversals(id) on delete restrict,
  supplier_return_id uuid references public.supplier_returns(id) on delete restrict,
  supplier_return_reversal_id uuid references public.supplier_return_reversals(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (variant_id, product_id) references public.product_variants(id, product_id) on delete restrict,
  unique (stock_bucket_id, revision_after),
  check (
    (movement in ('OPENING_STOCK', 'PURCHASE', 'SUPPLIER_RETURN_REVERSAL') and quantity_after > quantity_before)
    or (movement in ('PURCHASE_REVERSAL', 'SUPPLIER_RETURN') and quantity_after < quantity_before)
    or (movement = 'ADJUSTMENT' and quantity_after <> quantity_before)
  ),
  check (
    movement not in ('SUPPLIER_RETURN', 'SUPPLIER_RETURN_REVERSAL')
    or wac_after = wac_before
  ),
  check (
    (movement = 'OPENING_STOCK'
      and opening_stock_batch_id is not null and inventory_adjustment_execution_id is null
      and purchase_id is null and purchase_reversal_id is null and supplier_return_id is null and supplier_return_reversal_id is null)
    or (movement = 'ADJUSTMENT'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is not null
      and purchase_id is null and purchase_reversal_id is null and supplier_return_id is null and supplier_return_reversal_id is null)
    or (movement = 'PURCHASE'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_reversal_id is null and supplier_return_id is null and supplier_return_reversal_id is null)
    or (movement = 'PURCHASE_REVERSAL'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_reversal_id is not null and supplier_return_id is null and supplier_return_reversal_id is null)
    or (movement = 'SUPPLIER_RETURN'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_reversal_id is null and supplier_return_id is not null and supplier_return_reversal_id is null)
    or (movement = 'SUPPLIER_RETURN_REVERSAL'
      and opening_stock_batch_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_reversal_id is null and supplier_return_id is not null and supplier_return_reversal_id is not null)
  )
);
create unique index inventory_bucket_effects_opening_source_bucket_key on public.inventory_bucket_effects(opening_stock_batch_id, stock_bucket_id) where opening_stock_batch_id is not null;
create unique index inventory_bucket_effects_adjustment_source_bucket_key on public.inventory_bucket_effects(inventory_adjustment_execution_id, stock_bucket_id) where inventory_adjustment_execution_id is not null;
create unique index inventory_bucket_effects_purchase_source_bucket_key on public.inventory_bucket_effects(purchase_id, stock_bucket_id) where movement = 'PURCHASE';
create unique index inventory_bucket_effects_purchase_reversal_source_bucket_key on public.inventory_bucket_effects(purchase_reversal_id, stock_bucket_id) where purchase_reversal_id is not null;
create unique index inventory_bucket_effects_supplier_return_source_bucket_key on public.inventory_bucket_effects(supplier_return_id, stock_bucket_id) where movement = 'SUPPLIER_RETURN';
create unique index inventory_bucket_effects_supplier_return_reversal_source_bucket_key on public.inventory_bucket_effects(supplier_return_reversal_id, stock_bucket_id) where supplier_return_reversal_id is not null;

alter table public.inventory_movements
  add column bucket_effect_id uuid references public.inventory_bucket_effects(id) on delete restrict;
create index inventory_movements_bucket_effect_id_idx on public.inventory_movements(bucket_effect_id) where bucket_effect_id is not null;

create function public.validate_inventory_bucket_effect_identity()
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
    select 1
    from public.opening_stock_lines l
    where l.batch_id = new.opening_stock_batch_id
      and l.serialized = false
      and l.product_id = new.product_id
      and l.variant_id is not distinct from new.variant_id
      and l.condition = new.condition
  ) then
    raise exception 'Opening-stock bucket effect must reference a matching non-serialized opening-stock line';
  end if;
  if new.movement = 'ADJUSTMENT' then
    select * into adjustment_execution
    from public.inventory_adjustment_executions
    where id = new.inventory_adjustment_execution_id
    for key share;
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
  return new;
end
$$;
create trigger validate_inventory_bucket_effect_identity
before insert on public.inventory_bucket_effects
for each row execute function public.validate_inventory_bucket_effect_identity();

create or replace function public.validate_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare unit public.serialized_units; bucket public.stock_buckets; effect public.inventory_bucket_effects;
begin
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
    if new.bucket_effect_id is not null then
      select * into effect from public.inventory_bucket_effects where id = new.bucket_effect_id;
      if not found
         or effect.stock_bucket_id <> new.stock_bucket_id
         or effect.movement <> new.movement
         or effect.product_id <> new.product_id
         or effect.variant_id is distinct from new.variant_id
         or effect.condition is distinct from new.condition_after then
        raise exception 'Movement bucket_effect_id must match its bucket and typed operation';
      end if;
    end if;
  end if;
  return new;
end
$$;

-- General immutable lifecycle evidence. The explicit nullable FKs and typed
-- movement CHECK make free-form polymorphic references impossible.
create table public.serialized_unit_lifecycle_effects (
  id uuid primary key default gen_random_uuid(),
  movement public.movement_type not null,
  unit_id uuid not null references public.serialized_units(id) on delete restrict,
  movement_id uuid not null unique references public.inventory_movements(id) on delete restrict,
  status_before public.unit_status,
  status_after public.unit_status not null,
  condition_before public.product_condition,
  condition_after public.product_condition not null,
  unit_revision_before bigint not null check (unit_revision_before >= 0),
  unit_revision_after bigint not null check (unit_revision_after = unit_revision_before + 1),
  opening_stock_line_id uuid references public.opening_stock_lines(id) on delete restrict,
  inventory_adjustment_execution_id uuid references public.inventory_adjustment_executions(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete restrict,
  purchase_item_id uuid references public.purchase_items(id) on delete restrict,
  purchase_reversal_id uuid references public.purchase_reversals(id) on delete restrict,
  supplier_return_id uuid references public.supplier_returns(id) on delete restrict,
  supplier_return_line_id uuid references public.supplier_return_lines(id) on delete restrict,
  supplier_return_reversal_id uuid references public.supplier_return_reversals(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (
    movement not in ('OPENING_STOCK', 'PURCHASE')
    or (unit_revision_before = 0 and unit_revision_after = 1)
  ),
  check (
    (movement = 'OPENING_STOCK'
      and opening_stock_line_id is not null and inventory_adjustment_execution_id is null
      and purchase_id is null and purchase_item_id is null and purchase_reversal_id is null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null)
    or (movement = 'ADJUSTMENT'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is not null
      and purchase_id is null and purchase_item_id is null and purchase_reversal_id is null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null)
    or (movement = 'PURCHASE'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_item_id is not null and purchase_reversal_id is null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null)
    or (movement = 'PURCHASE_REVERSAL'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_item_id is not null and purchase_reversal_id is not null
      and supplier_return_id is null and supplier_return_line_id is null and supplier_return_reversal_id is null)
    or (movement = 'SUPPLIER_RETURN'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_item_id is not null and purchase_reversal_id is null
      and supplier_return_id is not null and supplier_return_line_id is not null and supplier_return_reversal_id is null)
    or (movement = 'SUPPLIER_RETURN_REVERSAL'
      and opening_stock_line_id is null and inventory_adjustment_execution_id is null
      and purchase_id is not null and purchase_item_id is not null and purchase_reversal_id is null
      and supplier_return_id is not null and supplier_return_line_id is not null and supplier_return_reversal_id is not null)
  )
);
create unique index serialized_unit_lifecycle_effects_unit_revision_key on public.serialized_unit_lifecycle_effects(unit_id, unit_revision_after);
create index serialized_unit_lifecycle_effects_purchase_item_idx on public.serialized_unit_lifecycle_effects(purchase_item_id) where purchase_item_id is not null;
create index serialized_unit_lifecycle_effects_supplier_return_line_idx on public.serialized_unit_lifecycle_effects(supplier_return_line_id) where supplier_return_line_id is not null;

create function public.validate_serialized_lifecycle_effect()
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
begin
  select * into movement_row from public.inventory_movements where id = new.movement_id for key share;
  if not found
     or movement_row.unit_id is distinct from new.unit_id
     or movement_row.movement <> new.movement
     or movement_row.condition_before is distinct from new.condition_before
     or movement_row.condition_after is distinct from new.condition_after then
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
      and (new.status_before is distinct from 'RETURNED_TO_SUPPLIER' or new.status_after is distinct from 'AVAILABLE' or movement_row.quantity <> 1)) then
    raise exception 'Serialized lifecycle effect has an invalid typed transition';
  end if;
  if new.movement not in ('OPENING_STOCK', 'PURCHASE')
     and (new.condition_before is null or new.condition_before is distinct from new.condition_after) then
    raise exception 'Serialized lifecycle non-creation transitions must preserve a non-null condition';
  end if;
  if new.movement = 'OPENING_STOCK' then
    select * into opening_line
    from public.opening_stock_lines
    where id = new.opening_stock_line_id
    for key share;
    if not found
       or unit_row.opening_stock_line_id is distinct from new.opening_stock_line_id
       or opening_line.product_id is distinct from unit_row.product_id
       or opening_line.variant_id is distinct from unit_row.variant_id
       or opening_line.condition is distinct from new.condition_after then
      raise exception 'Opening-stock lifecycle effect must reference the unit exact opening-stock source';
    end if;
  end if;
  if new.movement = 'ADJUSTMENT' then
    select * into adjustment_execution
    from public.inventory_adjustment_executions
    where id = new.inventory_adjustment_execution_id
    for key share;
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
    select * into supplier_return_reversal from public.supplier_return_reversals where id = new.supplier_return_reversal_id for key share;
    if not found or supplier_return_reversal.supplier_return_id is distinct from new.supplier_return_id then
      raise exception 'Serialized lifecycle supplier-return reversal must reference its supplier return';
    end if;
  end if;
  return new;
end
$$;
create trigger validate_serialized_lifecycle_effect
before insert on public.serialized_unit_lifecycle_effects
for each row execute function public.validate_serialized_lifecycle_effect();

create table public.procurement_operation_reservations (
  request_id uuid primary key,
  operation public.procurement_operation_kind not null,
  request_fingerprint text not null check (request_fingerprint = lower(btrim(request_fingerprint)) and request_fingerprint <> ''),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  completed_entity_type text check (completed_entity_type is null or (completed_entity_type = btrim(completed_entity_type) and completed_entity_type <> '')),
  completed_entity_id uuid,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (completed_at is null and completed_entity_type is null and completed_entity_id is null and result is null)
    or (completed_at is not null and result is not null)
  )
);
create index procurement_operation_reservations_actor_created_idx on public.procurement_operation_reservations(actor_id, created_at desc);

-- Procurement/history immutability. Reservations intentionally remain mutable
-- until completed by the future atomic idempotency workflow.
create trigger immutable_purchases before update or delete on public.purchases for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_purchase_items before update or delete on public.purchase_items for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_purchase_reversals before update or delete on public.purchase_reversals for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_supplier_payments before update or delete on public.supplier_payments for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_supplier_payment_reversals before update or delete on public.supplier_payment_reversals for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_supplier_returns before update or delete on public.supplier_returns for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_supplier_return_lines before update or delete on public.supplier_return_lines for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_supplier_return_reversals before update or delete on public.supplier_return_reversals for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_supplier_refund_receipts before update or delete on public.supplier_refund_receipts for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_supplier_refund_receipt_reversals before update or delete on public.supplier_refund_receipt_reversals for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_inventory_bucket_effects before update or delete on public.inventory_bucket_effects for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_serialized_unit_lifecycle_effects before update or delete on public.serialized_unit_lifecycle_effects for each row execute function public.forbid_procurement_history_mutation();
create trigger immutable_audit_logs before update or delete on public.audit_logs for each row execute function public.forbid_procurement_history_mutation();

-- Derived financial information is management-only through underlying RLS.
create view public.purchase_financial_summary
with (security_invoker = true)
as
with active_payments as (
  select sp.purchase_id, coalesce(sum(sp.amount), 0)::numeric(14,2) as net_supplier_payments
  from public.supplier_payments sp
  left join public.supplier_payment_reversals spr on spr.supplier_payment_id = sp.id
  where spr.id is null
  group by sp.purchase_id
),
active_returns as (
  select sr.purchase_id, coalesce(sum(sr.total), 0)::numeric(14,2) as active_return_value
  from public.supplier_returns sr
  left join public.supplier_return_reversals srr on srr.supplier_return_id = sr.id
  where srr.id is null
  group by sr.purchase_id
)
select
  p.id as purchase_id,
  p.supplier_id,
  p.purchase_number,
  case when pr.id is null then 'ACTIVE' else 'REVERSED' end as purchase_state,
  p.total as historical_original_total,
  coalesce(ar.active_return_value, 0)::numeric(14,2) as active_return_value,
  case when pr.id is null then greatest(p.total - coalesce(ar.active_return_value, 0), 0)::numeric(14,2) else 0::numeric(14,2) end as operational_revised_payable,
  coalesce(ap.net_supplier_payments, 0)::numeric(14,2) as net_supplier_payments,
  case when pr.id is null then greatest(greatest(p.total - coalesce(ar.active_return_value, 0), 0) - coalesce(ap.net_supplier_payments, 0), 0)::numeric(14,2) else 0::numeric(14,2) end as amount_still_payable,
  case
    when pr.id is not null then 'NOT_APPLICABLE'
    when greatest(p.total - coalesce(ar.active_return_value, 0), 0) = 0 then 'PAID'
    when coalesce(ap.net_supplier_payments, 0) = 0 then 'UNPAID'
    when coalesce(ap.net_supplier_payments, 0) < greatest(p.total - coalesce(ar.active_return_value, 0), 0) then 'PARTIALLY_PAID'
    else 'PAID'
  end as payment_status
from public.purchases p
left join public.purchase_reversals pr on pr.purchase_id = p.id
left join active_payments ap on ap.purchase_id = p.id
left join active_returns ar on ar.purchase_id = p.id;

-- Management-only RLS, no browser transactional writes, and no Staff exposure.
alter table public.purchase_reversals enable row level security;
alter table public.supplier_payments enable row level security;
alter table public.supplier_payment_reversals enable row level security;
alter table public.supplier_returns enable row level security;
alter table public.supplier_return_lines enable row level security;
alter table public.supplier_return_reversals enable row level security;
alter table public.supplier_refund_receipts enable row level security;
alter table public.supplier_refund_receipt_reversals enable row level security;
alter table public.inventory_bucket_effects enable row level security;
alter table public.serialized_unit_lifecycle_effects enable row level security;
alter table public.procurement_operation_reservations enable row level security;

create policy "management read purchase reversals" on public.purchase_reversals for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read supplier payments" on public.supplier_payments for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read supplier payment reversals" on public.supplier_payment_reversals for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read supplier returns" on public.supplier_returns for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read supplier return lines" on public.supplier_return_lines for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read supplier return reversals" on public.supplier_return_reversals for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read supplier refund receipts" on public.supplier_refund_receipts for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read supplier refund receipt reversals" on public.supplier_refund_receipt_reversals for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read inventory bucket effects" on public.inventory_bucket_effects for select using (public.current_role() in ('ADMIN', 'MANAGER'));
create policy "management read serialized lifecycle effects" on public.serialized_unit_lifecycle_effects for select using (public.current_role() in ('ADMIN', 'MANAGER'));

revoke all on table public.suppliers, public.purchases, public.purchase_items, public.purchase_reversals, public.supplier_payments, public.supplier_payment_reversals, public.supplier_returns, public.supplier_return_lines, public.supplier_return_reversals, public.supplier_refund_receipts, public.supplier_refund_receipt_reversals, public.inventory_bucket_effects, public.serialized_unit_lifecycle_effects, public.procurement_operation_reservations from public, anon, authenticated;
grant select on table public.suppliers, public.purchases, public.purchase_items, public.purchase_reversals, public.supplier_payments, public.supplier_payment_reversals, public.supplier_returns, public.supplier_return_lines, public.supplier_return_reversals, public.supplier_refund_receipts, public.supplier_refund_receipt_reversals, public.inventory_bucket_effects, public.serialized_unit_lifecycle_effects to authenticated;
revoke all on table public.purchase_financial_summary from public, anon, authenticated;
grant select on table public.purchase_financial_summary to authenticated;

revoke all on function public.forbid_supplier_delete(), public.enforce_stock_bucket_revision(), public.enforce_serialized_lifecycle_revision(), public.forbid_procurement_history_mutation(), public.validate_serialized_purchase_origin(), public.validate_inventory_movement(), public.validate_inventory_bucket_effect_identity(), public.validate_serialized_lifecycle_effect(), public.validate_supplier_payment_reversal(), public.validate_supplier_return_line() from public, anon, authenticated;

create index supplier_payments_purchase_paid_on_idx on public.supplier_payments(purchase_id, paid_on desc);
create index supplier_return_lines_purchase_item_id_idx on public.supplier_return_lines(purchase_item_id);
create index supplier_return_lines_serialized_unit_id_idx on public.supplier_return_lines(serialized_unit_id) where serialized_unit_id is not null;
create index supplier_returns_purchase_history_idx on public.supplier_returns(purchase_id, created_at desc);
create index supplier_refund_receipts_return_received_idx on public.supplier_refund_receipts(supplier_return_id, received_on desc);

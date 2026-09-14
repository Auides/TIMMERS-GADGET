-- Gate 2 revised, UNAPPLIED foundational schema. Transactional workflow RPCs arrive later.
create extension if not exists pgcrypto;

create type public.app_role as enum ('ADMIN', 'MANAGER', 'STAFF');
create type public.product_condition as enum ('NEW', 'USED', 'REFURBISHED');
create type public.unit_status as enum ('AVAILABLE', 'SOLD', 'RETURN_PENDING');
create type public.identifier_type as enum ('IMEI_1', 'IMEI_2', 'SERIAL');
create type public.movement_type as enum ('PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'REVERSAL', 'EXCHANGE');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  full_name text not null check (full_name = btrim(full_name) and full_name <> ''),
  role public.app_role not null default 'STAFF', is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.categories (id uuid primary key default gen_random_uuid(), name text not null check(name = btrim(name) and name <> ''), created_at timestamptz not null default now());
create unique index categories_name_normalized_key on public.categories ((lower(name)));
create table public.brands (id uuid primary key default gen_random_uuid(), name text not null check(name = btrim(name) and name <> ''), created_at timestamptz not null default now());
create unique index brands_name_normalized_key on public.brands ((lower(name)));

-- A product is a catalog item. Current condition and cost intentionally do not live here.
create table public.products (
  id uuid primary key default gen_random_uuid(), name text not null check(name = btrim(name) and name <> ''),
  sku text not null unique check(sku = upper(btrim(sku)) and sku <> ''), barcode text unique check(barcode is null or (barcode = upper(btrim(barcode)) and barcode <> '')),
  model text, description text, category_id uuid references public.categories(id) on delete restrict,
  brand_id uuid references public.brands(id) on delete restrict, serialized boolean not null default false,
  minimum_stock integer not null default 0 check(minimum_stock >= 0), warranty_months integer check(warranty_months >= 0),
  active boolean not null default true, created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id, serialized)
);
create table public.product_variants (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id) on delete restrict,
  label text not null check(label = btrim(label) and label <> ''), sku text check(sku is null or (sku = upper(btrim(sku)) and sku <> '')),
  barcode text check(barcode is null or (barcode = upper(btrim(barcode)) and barcode <> '')), attributes jsonb not null default '{}'::jsonb,
  active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(id, product_id), unique(product_id, label)
);
create unique index variants_sku_key on public.product_variants(sku) where sku is not null;
create unique index variants_barcode_key on public.product_variants(barcode) where barcode is not null;

-- One row is the authoritative current non-serialized sellable bucket, including its condition and weighted cost.
create table public.stock_buckets (
  id uuid primary key default gen_random_uuid(), product_id uuid not null, variant_id uuid,
  serialized boolean not null default false, condition public.product_condition not null, quantity integer not null default 0 check(quantity >= 0),
  selling_price numeric(14,2) not null check(selling_price >= 0), weighted_average_cost numeric(14,2) not null default 0 check(weighted_average_cost >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (product_id, serialized) references public.products(id, serialized) on delete restrict,
  check (serialized = false), foreign key (variant_id, product_id) references public.product_variants(id, product_id) on delete restrict
);
-- PostgreSQL treats NULLs as distinct in ordinary unique constraints; this expression index makes NULL mean “base product”.
create unique index stock_buckets_identity_key on public.stock_buckets (product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), condition);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(), business_name text not null check(business_name = btrim(business_name) and business_name <> ''),
  contact_name text, phone text, email text, address text, notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.purchases (
  id uuid primary key default gen_random_uuid(), supplier_id uuid not null references public.suppliers(id) on delete restrict,
  reference text unique, purchased_on date not null default current_date, total numeric(14,2) not null check(total >= 0),
  amount_paid numeric(14,2) not null default 0 check(amount_paid between 0 and total), created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.purchase_items (
  id uuid primary key default gen_random_uuid(), purchase_id uuid not null references public.purchases(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict, variant_id uuid, quantity integer not null check(quantity > 0),
  unit_cost numeric(14,2) not null check(unit_cost >= 0), created_at timestamptz not null default now(),
  unique(id, product_id, variant_id), foreign key(variant_id, product_id) references public.product_variants(id, product_id) on delete restrict
);

-- Serialized units are operationally visible only via a masked view; their actual cost is never in Staff projections.
create table public.serialized_units (
  id uuid primary key default gen_random_uuid(), product_id uuid not null, variant_id uuid, purchase_item_id uuid not null,
  condition public.product_condition not null, status public.unit_status not null default 'AVAILABLE',
  current_selling_price numeric(14,2) not null check(current_selling_price >= 0), acquisition_cost numeric(14,2) not null check(acquisition_cost >= 0),
  warranty_start date, warranty_expiry date, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(product_id) references public.products(id) on delete restrict,
  foreign key(variant_id, product_id) references public.product_variants(id, product_id) on delete restrict,
  foreign key(purchase_item_id) references public.purchase_items(id) on delete restrict,
  check(warranty_expiry is null or warranty_start is null or warranty_expiry >= warranty_start)
);
create table public.unit_identifiers (
  id uuid primary key default gen_random_uuid(), unit_id uuid not null references public.serialized_units(id) on delete restrict,
  identifier_type public.identifier_type not null, normalized_value text not null,
  created_at timestamptz not null default now(), unique(normalized_value), unique(unit_id, identifier_type), unique(unit_id, normalized_value),
  check((identifier_type not in ('IMEI_1', 'IMEI_2')) or normalized_value ~ '^[0-9]{14,16}$')
);

-- Immutable append-only inventory history. Cost fields are restricted by RLS and never selected by Staff views.
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(), product_id uuid not null, variant_id uuid, unit_id uuid references public.serialized_units(id) on delete restrict,
  stock_bucket_id uuid references public.stock_buckets(id) on delete restrict, movement public.movement_type not null, quantity integer not null check(quantity <> 0),
  condition_before public.product_condition, condition_after public.product_condition, unit_cost numeric(14,2) check(unit_cost >= 0),
  reference_type text not null check(reference_type = btrim(reference_type) and reference_type <> ''), reference_id uuid not null,
  reason text, performed_by uuid not null references public.profiles(id), created_at timestamptz not null default now(),
  foreign key(variant_id, product_id) references public.product_variants(id, product_id) on delete restrict,
  check((unit_id is null and stock_bucket_id is not null) or (unit_id is not null and stock_bucket_id is null)),
  check((unit_id is null) or quantity in (-1, 1))
);
create table public.customers (
  id uuid primary key default gen_random_uuid(), full_name text not null check(full_name = btrim(full_name) and full_name <> ''),
  phone text, email text, address text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), actor_id uuid references public.profiles(id), action text not null, entity_type text not null,
  entity_id uuid, before_data jsonb, after_data jsonb, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

create or replace function public.current_role() returns public.app_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active = true
$$;
create or replace function public.is_active_user() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and is_active = true)
$$;
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create or replace function public.normalize_identifier() returns trigger language plpgsql as $$ begin new.normalized_value = upper(btrim(new.normalized_value)); if new.normalized_value = '' then raise exception 'Identifier cannot be empty'; end if; return new; end $$;
create or replace function public.normalize_catalog_identifiers() returns trigger language plpgsql as $$ begin new.sku = upper(btrim(new.sku)); if new.barcode is not null then new.barcode = upper(btrim(new.barcode)); end if; return new; end $$;
create or replace function public.validate_catalog_identifiers() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sku is not null then perform pg_advisory_xact_lock(hashtext('sku:' || new.sku)); end if;
  if new.barcode is not null then perform pg_advisory_xact_lock(hashtext(new.barcode)); end if;
  if tg_table_name = 'products' then
    if exists(select 1 from public.product_variants where sku = new.sku or (new.barcode is not null and barcode = new.barcode)) then raise exception 'Product SKU or barcode conflicts with a variant identifier'; end if;
  else
    if new.sku is not null and exists(select 1 from public.products where sku = new.sku) or new.barcode is not null and exists(select 1 from public.products where barcode = new.barcode) then raise exception 'Variant SKU or barcode conflicts with a product identifier'; end if;
  end if;
  return new;
end $$;
create or replace function public.validate_serialized_purchase_origin() returns trigger language plpgsql security definer set search_path = public as $$
declare item public.purchase_items; product_is_serialized boolean; linked_unit_count integer;
begin select serialized into product_is_serialized from public.products where id = new.product_id; if product_is_serialized is distinct from true then raise exception 'Serialized units may reference only serialized products'; end if;
  select * into item from public.purchase_items where id = new.purchase_item_id for update; if not found or item.product_id <> new.product_id or item.variant_id is distinct from new.variant_id then raise exception 'Serialized unit purchase origin must match its product and variant'; end if;
  if new.acquisition_cost is distinct from item.unit_cost then raise exception 'Serialized acquisition cost must equal its purchase item cost'; end if;
  if tg_op = 'INSERT' then select count(*) into linked_unit_count from public.serialized_units where purchase_item_id = new.purchase_item_id; if linked_unit_count >= item.quantity then raise exception 'Serialized unit count cannot exceed the purchase item quantity'; end if; end if;
  if tg_op = 'UPDATE' and (new.purchase_item_id is distinct from old.purchase_item_id or new.acquisition_cost is distinct from old.acquisition_cost) then raise exception 'Serialized acquisition origin and cost are immutable'; end if; return new; end $$;
create or replace function public.protect_linked_purchase_item() returns trigger language plpgsql security definer set search_path = public as $$
begin if exists(select 1 from public.serialized_units where purchase_item_id = old.id) and (new.purchase_id is distinct from old.purchase_id or new.product_id is distinct from old.product_id or new.variant_id is distinct from old.variant_id or new.unit_cost is distinct from old.unit_cost or new.quantity is distinct from old.quantity) then raise exception 'Acquisition-defining purchase item fields are immutable once serialized units are registered'; end if; return new; end $$;
create or replace function public.protect_product_tracking_mode() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.serialized is distinct from old.serialized then
    if exists(select 1 from public.serialized_units where product_id = old.id) or exists(select 1 from public.stock_buckets where product_id = old.id) or exists(select 1 from public.inventory_movements where product_id = old.id) then
      raise exception 'Product tracking mode is immutable once inventory or inventory history exists';
    end if;
  end if;
  return new;
end $$;
create or replace function public.validate_inventory_movement() returns trigger language plpgsql security definer set search_path = public as $$
declare unit public.serialized_units; bucket public.stock_buckets;
begin
  if new.unit_id is not null then select * into unit from public.serialized_units where id = new.unit_id; if not found or unit.product_id <> new.product_id or unit.variant_id is distinct from new.variant_id then raise exception 'Unit must match movement product and variant'; end if;
  else select * into bucket from public.stock_buckets where id = new.stock_bucket_id; if not found or bucket.product_id <> new.product_id or bucket.variant_id is distinct from new.variant_id then raise exception 'Stock bucket must match movement product and variant'; end if; end if; return new;
end $$;
create or replace function public.forbid_history_mutation() returns trigger language plpgsql as $$ begin raise exception 'Historical inventory movements are immutable'; end $$;

create trigger normalize_unit_identifier before insert or update on public.unit_identifiers for each row execute function public.normalize_identifier();
create trigger normalize_product_identifiers before insert or update of sku, barcode on public.products for each row execute function public.normalize_catalog_identifiers();
create trigger validate_product_identifiers before insert or update of sku, barcode on public.products for each row execute function public.validate_catalog_identifiers();
create trigger normalize_variant_identifiers before insert or update of sku, barcode on public.product_variants for each row execute function public.normalize_catalog_identifiers();
create trigger validate_variant_identifiers before insert or update of sku, barcode on public.product_variants for each row execute function public.validate_catalog_identifiers();
create trigger validate_unit_purchase_origin before insert or update on public.serialized_units for each row execute function public.validate_serialized_purchase_origin();
create trigger protect_linked_purchase_item before update on public.purchase_items for each row execute function public.protect_linked_purchase_item();
create trigger protect_product_tracking_mode before update of serialized on public.products for each row execute function public.protect_product_tracking_mode();
create trigger validate_movement before insert on public.inventory_movements for each row execute function public.validate_inventory_movement();
create trigger immutable_movement before update or delete on public.inventory_movements for each row execute function public.forbid_history_mutation();
create trigger profiles_updated before update on public.profiles for each row execute function public.touch_updated_at();
create trigger products_updated before update on public.products for each row execute function public.touch_updated_at();
create trigger variants_updated before update on public.product_variants for each row execute function public.touch_updated_at();
create trigger buckets_updated before update on public.stock_buckets for each row execute function public.touch_updated_at();
create trigger units_updated before update on public.serialized_units for each row execute function public.touch_updated_at();
create trigger suppliers_updated before update on public.suppliers for each row execute function public.touch_updated_at();
create trigger purchases_updated before update on public.purchases for each row execute function public.touch_updated_at();
create trigger customers_updated before update on public.customers for each row execute function public.touch_updated_at();

alter table public.profiles enable row level security; alter table public.categories enable row level security; alter table public.brands enable row level security; alter table public.products enable row level security; alter table public.product_variants enable row level security; alter table public.stock_buckets enable row level security; alter table public.serialized_units enable row level security; alter table public.unit_identifiers enable row level security; alter table public.inventory_movements enable row level security; alter table public.suppliers enable row level security; alter table public.purchases enable row level security; alter table public.purchase_items enable row level security; alter table public.customers enable row level security; alter table public.audit_logs enable row level security;

-- Base tables containing acquisition cost, suppliers, purchases and audit records: no STAFF SELECT policy.
create policy "self profile" on public.profiles for select using (id = auth.uid());
create policy "admins read profiles" on public.profiles for select using (public.current_role() = 'ADMIN');
create policy "management read catalog" on public.categories for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read brands" on public.brands for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read products" on public.products for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read variants" on public.product_variants for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read stock buckets" on public.stock_buckets for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read units" on public.serialized_units for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read identifiers" on public.unit_identifiers for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read inventory ledger" on public.inventory_movements for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read suppliers" on public.suppliers for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read purchases" on public.purchases for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read purchase items" on public.purchase_items for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "management read customers" on public.customers for select using (public.current_role() in ('ADMIN','MANAGER'));
create policy "admins read audit" on public.audit_logs for select using (public.current_role() = 'ADMIN');

-- Staff projections are RPCs rather than owner-executed views. Each function checks the active profile before using definer privileges.
create or replace function public.require_active_profile() returns void language plpgsql security definer set search_path = public as $$ begin if auth.uid() is null or not public.is_active_user() then raise insufficient_privilege using message = 'An active TIMMERS GADGET profile is required'; end if; end $$;
create or replace function public.staff_catalog_lookup() returns table(product_id uuid, product_name text, product_sku text, product_barcode text, brand_name text, category_name text, serialized boolean, variant_id uuid, variant_label text, variant_sku text, variant_barcode text, condition public.product_condition, quantity integer, selling_price numeric) language plpgsql security definer set search_path = public as $$ begin perform public.require_active_profile(); return query select p.id, p.name, p.sku, p.barcode, br.name, c.name, p.serialized, v.id, v.label, v.sku, v.barcode, b.condition, b.quantity, b.selling_price from public.products p left join public.brands br on br.id = p.brand_id left join public.categories c on c.id = p.category_id left join public.product_variants v on v.product_id = p.id and v.active left join public.stock_buckets b on b.product_id = p.id and b.variant_id is not distinct from v.id where p.active and not p.serialized; end $$;
create or replace function public.staff_serialized_lookup(search_text text) returns table(unit_id uuid, product_id uuid, product_name text, product_sku text, product_barcode text, product_model text, brand_name text, category_name text, variant_id uuid, variant_label text, variant_sku text, variant_barcode text, condition public.product_condition, status public.unit_status, selling_price numeric, identifier_type public.identifier_type, identifier_value text) language plpgsql security definer set search_path = public as $$ begin perform public.require_active_profile(); if search_text is null or btrim(search_text) = '' then raise exception 'A serialized identifier or product search value is required'; end if; return query select u.id, p.id, p.name, p.sku, p.barcode, p.model, br.name, c.name, v.id, v.label, v.sku, v.barcode, u.condition, u.status, u.current_selling_price, i.identifier_type, i.normalized_value from public.serialized_units u join public.products p on p.id = u.product_id left join public.brands br on br.id = p.brand_id left join public.categories c on c.id = p.category_id left join public.product_variants v on v.id = u.variant_id join public.unit_identifiers i on i.unit_id = u.id where u.status in ('AVAILABLE','SOLD','RETURN_PENDING') and (i.normalized_value = upper(btrim(search_text)) or p.sku = upper(btrim(search_text)) or p.barcode = upper(btrim(search_text)) or v.sku = upper(btrim(search_text)) or v.barcode = upper(btrim(search_text)) or p.name ilike '%' || btrim(search_text) || '%') order by u.created_at desc limit 50; end $$;
create or replace function public.staff_customer_lookup(search_text text default null) returns table(customer_id uuid, full_name text, phone text, email text) language plpgsql security definer set search_path = public as $$ begin perform public.require_active_profile(); return query select c.id, c.full_name, c.phone, c.email from public.customers c where search_text is null or c.full_name ilike '%' || btrim(search_text) || '%' or c.phone ilike '%' || btrim(search_text) || '%' order by c.full_name limit 50; end $$;
revoke all on function public.require_active_profile() from public;
revoke all on function public.staff_catalog_lookup() from public;
revoke all on function public.staff_serialized_lookup(text) from public;
revoke all on function public.staff_customer_lookup(text) from public;
grant execute on function public.staff_catalog_lookup(), public.staff_serialized_lookup(text), public.staff_customer_lookup(text) to authenticated;

create index products_category_id_idx on public.products(category_id); create index products_brand_id_idx on public.products(brand_id); create index products_search_idx on public.products using gin(to_tsvector('simple', name || ' ' || coalesce(model, '') || ' ' || sku)); create index variants_product_id_idx on public.product_variants(product_id); create index buckets_product_variant_condition_idx on public.stock_buckets(product_id, variant_id, condition); create index purchases_supplier_id_idx on public.purchases(supplier_id); create index purchases_purchased_on_idx on public.purchases(purchased_on); create index purchase_items_purchase_id_idx on public.purchase_items(purchase_id); create index purchase_items_product_variant_idx on public.purchase_items(product_id, variant_id); create index units_product_variant_status_idx on public.serialized_units(product_id, variant_id, status); create index units_purchase_item_id_idx on public.serialized_units(purchase_item_id); create index identifiers_unit_id_idx on public.unit_identifiers(unit_id); create index customers_phone_idx on public.customers(phone) where phone is not null; create index movements_product_created_idx on public.inventory_movements(product_id, created_at desc); create index movements_unit_id_idx on public.inventory_movements(unit_id); create index movements_bucket_id_idx on public.inventory_movements(stock_bucket_id); create index audit_entity_idx on public.audit_logs(entity_type, entity_id, created_at desc);

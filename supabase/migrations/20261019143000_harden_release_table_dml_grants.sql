revoke insert, update, delete, truncate
on table
  public.customers,
  public.serialized_units,
  public.stock_buckets,
  public.unit_identifiers
from anon, authenticated;

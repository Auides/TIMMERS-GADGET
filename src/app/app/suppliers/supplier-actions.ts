"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { canManageProcurement } from "@/lib/authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupplierActionState } from "./supplier-action-state";

const optionalText = z.string().trim().transform((value) => value || null);
const supplierFields = z.object({
  businessName: z.string().trim().min(1),
  contactName: optionalText,
  phone: optionalText,
  email: optionalText,
  address: optionalText,
  notes: optionalText,
});
const supplierId = z.string().uuid();

function errorState(message: string): SupplierActionState {
  return { status: "error", message };
}

function safeSupplierMutationMessage(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("procurement authority") || normalized.includes("active timmers gadget profile") || normalized.includes("permission denied")) {
    return "Access denied. You do not have permission to manage suppliers.";
  }
  if (normalized.includes("supplier business name is required")) return "Enter a supplier business name.";
  if (normalized.includes("archived supplier business name cannot be changed")) return "Archived supplier business names cannot be changed.";
  if (normalized.includes("archived supplier contact update requires")) return "This contact update is available only for archived suppliers.";
  if (normalized.includes("supplier is already archived")) return "This supplier is already archived.";
  if (normalized.includes("supplier does not exist")) return "This supplier is no longer available.";

  return "We could not save the supplier. Check your connection and try again.";
}

async function getSupplierManagerClient() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || profile.id !== user.id || !profile.is_active || !canManageProcurement(profile.role)) return null;

  return { supabase, user, profile };
}

async function currentSupplierState(supabase: NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>, id: string) {
  const { data, error } = await supabase.from("suppliers").select("active").eq("id", id).maybeSingle();
  return error || !data ? null : Boolean(data.active);
}

function revalidateSupplierPaths(id?: string) {
  revalidatePath("/app/suppliers");
  if (id) revalidatePath(`/app/suppliers/${id}`);
}

function supplierArguments(value: z.infer<typeof supplierFields>) {
  return {
    p_business_name: value.businessName,
    p_contact_name: value.contactName,
    p_phone: value.phone,
    p_email: value.email,
    p_address: value.address,
    p_notes: value.notes,
  };
}

function returnedSupplierId(data: unknown) {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" && "id" in row && typeof row.id === "string" ? row.id : null;
}

export async function createSupplier(_: SupplierActionState, formData: FormData): Promise<SupplierActionState> {
  const parsed = supplierFields.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Enter a supplier business name.");

  let createdSupplierId: string | null = null;
  try {
    const context = await getSupplierManagerClient();
    if (!context) return errorState("Access denied. You do not have permission to manage suppliers.");

    const rpcArguments = supplierArguments(parsed.data);
    const { data, error } = await context.supabase.rpc("supplier_create", rpcArguments);
    if (error) return errorState(safeSupplierMutationMessage(error.message));

    createdSupplierId = returnedSupplierId(data);
  } catch (error) {
    return errorState(safeSupplierMutationMessage(error instanceof Error ? error.message : ""));
  }

  revalidateSupplierPaths();
  redirect(createdSupplierId ? `/app/suppliers/${createdSupplierId}` : "/app/suppliers");
}

export async function updateActiveSupplier(_: SupplierActionState, formData: FormData): Promise<SupplierActionState> {
  const parsed = supplierFields.extend({ id: supplierId }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Enter a supplier business name and check the supplier details.");

  try {
    const context = await getSupplierManagerClient();
    if (!context) return errorState("Access denied. You do not have permission to manage suppliers.");
    if (await currentSupplierState(context.supabase, parsed.data.id) !== true) {
      return errorState("This supplier is archived or unavailable. Only archived contact details can be changed after archival.");
    }

    const rpcArguments = { p_supplier_id: parsed.data.id, ...supplierArguments(parsed.data) };
    const { error } = await context.supabase.rpc("supplier_update", rpcArguments);
    if (error) return errorState(safeSupplierMutationMessage(error.message));
  } catch (error) {
    return errorState(safeSupplierMutationMessage(error instanceof Error ? error.message : ""));
  }

  revalidateSupplierPaths(parsed.data.id);
  return { status: "success", message: "Supplier details updated." };
}

export async function updateArchivedSupplierContact(_: SupplierActionState, formData: FormData): Promise<SupplierActionState> {
  const parsed = z.object({
    id: supplierId,
    contactName: optionalText,
    phone: optionalText,
    email: optionalText,
    address: optionalText,
    notes: optionalText,
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Check the contact details and try again.");

  try {
    const context = await getSupplierManagerClient();
    if (!context) return errorState("Access denied. You do not have permission to manage suppliers.");
    if (await currentSupplierState(context.supabase, parsed.data.id) !== false) {
      return errorState("This supplier is active or unavailable. Use the full supplier edit while it remains active.");
    }

    const rpcArguments = {
      p_supplier_id: parsed.data.id,
      p_contact_name: parsed.data.contactName,
      p_phone: parsed.data.phone,
      p_email: parsed.data.email,
      p_address: parsed.data.address,
      p_notes: parsed.data.notes,
    };
    const { error } = await context.supabase.rpc("supplier_update_archived_contact", rpcArguments);
    if (error) return errorState(safeSupplierMutationMessage(error.message));
  } catch (error) {
    return errorState(safeSupplierMutationMessage(error instanceof Error ? error.message : ""));
  }

  revalidateSupplierPaths(parsed.data.id);
  return { status: "success", message: "Archived supplier contact details updated." };
}

export async function archiveSupplier(_: SupplierActionState, formData: FormData): Promise<SupplierActionState> {
  const parsed = z.object({ id: supplierId, archiveConfirmed: z.literal("yes") }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("Confirm that you want to archive this supplier.");

  try {
    const context = await getSupplierManagerClient();
    if (!context) return errorState("Access denied. You do not have permission to manage suppliers.");
    if (await currentSupplierState(context.supabase, parsed.data.id) !== true) return errorState("This supplier is already archived or unavailable.");

    const rpcArguments = { p_supplier_id: parsed.data.id };
    const { error } = await context.supabase.rpc("supplier_archive", rpcArguments);
    if (error) return errorState(safeSupplierMutationMessage(error.message));
  } catch (error) {
    return errorState(safeSupplierMutationMessage(error instanceof Error ? error.message : ""));
  }

  revalidateSupplierPaths(parsed.data.id);
  return { status: "success", message: "Supplier archived." };
}

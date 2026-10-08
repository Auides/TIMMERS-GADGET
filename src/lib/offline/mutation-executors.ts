import { customerCreateExecutor } from "./customer-create.ts";
import { customerUpdateExecutor } from "./customer-update.ts";
import { supplierCreateExecutor } from "./supplier-create.ts";
import { supplierUpdateExecutor } from "./supplier-update.ts";
import { purchaseReceiveExecutor } from "./purchase-receive.ts";
import { inventoryAdjustmentRequestExecutor } from "./inventory-adjustment-request.ts";
import type { MutationExecutorRegistry } from "./mutation-transport.ts";

/** The registry is an explicit allow-list; no service worker or legacy outbox replay exists. */
export const registeredOfflineMutationExecutors: MutationExecutorRegistry = new Map([
  ["CUSTOMER_CREATE", customerCreateExecutor],
  ["CUSTOMER_UPDATE", customerUpdateExecutor],
  ["SUPPLIER_CREATE", supplierCreateExecutor],
  ["SUPPLIER_UPDATE", supplierUpdateExecutor],
  ["PURCHASE_RECEIVE", purchaseReceiveExecutor],
  ["INVENTORY_ADJUSTMENT_REQUEST_CREATE", inventoryAdjustmentRequestExecutor],
]);

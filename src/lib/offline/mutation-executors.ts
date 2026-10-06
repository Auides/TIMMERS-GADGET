import { customerCreateExecutor } from "./customer-create.ts";
import { customerUpdateExecutor } from "./customer-update.ts";
import { supplierCreateExecutor } from "./supplier-create.ts";
import { supplierUpdateExecutor } from "./supplier-update.ts";
import { purchaseReceiveExecutor } from "./purchase-receive.ts";
import type { MutationExecutorRegistry } from "./mutation-transport.ts";

/** Phase 6C-B enables the five approved offline commands and no implicit replay paths. */
export const registeredOfflineMutationExecutors: MutationExecutorRegistry = new Map([
  ["CUSTOMER_CREATE", customerCreateExecutor],
  ["CUSTOMER_UPDATE", customerUpdateExecutor],
  ["SUPPLIER_CREATE", supplierCreateExecutor],
  ["SUPPLIER_UPDATE", supplierUpdateExecutor],
  ["PURCHASE_RECEIVE", purchaseReceiveExecutor],
]);

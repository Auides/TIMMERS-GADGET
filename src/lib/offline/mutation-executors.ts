import { customerCreateExecutor } from "./customer-create.ts";
import { customerUpdateExecutor } from "./customer-update.ts";
import { supplierCreateExecutor } from "./supplier-create.ts";
import { supplierUpdateExecutor } from "./supplier-update.ts";
import type { MutationExecutorRegistry } from "./mutation-transport.ts";

/** Phase 6B deliberately enables only customer create/update and Manager supplier create/update. */
export const registeredOfflineMutationExecutors: MutationExecutorRegistry = new Map([
  ["CUSTOMER_CREATE", customerCreateExecutor],
  ["CUSTOMER_UPDATE", customerUpdateExecutor],
  ["SUPPLIER_CREATE", supplierCreateExecutor],
  ["SUPPLIER_UPDATE", supplierUpdateExecutor],
]);

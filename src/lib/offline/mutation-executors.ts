import { customerCreateExecutor } from "./customer-create.ts";
import { customerUpdateExecutor } from "./customer-update.ts";
import type { MutationExecutorRegistry } from "./mutation-transport.ts";

/** Phase 5B deliberately enables only the approved customer create/update commands. */
export const registeredOfflineMutationExecutors: MutationExecutorRegistry = new Map([
  ["CUSTOMER_CREATE", customerCreateExecutor],
  ["CUSTOMER_UPDATE", customerUpdateExecutor],
]);

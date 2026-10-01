import { customerCreateExecutor } from "./customer-create.ts";
import type { MutationExecutorRegistry } from "./mutation-transport.ts";

/** Phase 5A deliberately enables exactly one real business command. */
export const registeredOfflineMutationExecutors: MutationExecutorRegistry = new Map([
  ["CUSTOMER_CREATE", customerCreateExecutor],
]);

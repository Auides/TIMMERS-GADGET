export type Role = "ADMIN" | "MANAGER" | "STAFF";
const permissions = { manageUsers: ["ADMIN"], adjustInventory: ["ADMIN", "MANAGER"], manageProcurement: ["ADMIN", "MANAGER"], recordExpenses: ["ADMIN", "MANAGER"], approveReturns: ["ADMIN"], reverseSales: ["ADMIN"], approveCredit: ["ADMIN", "MANAGER"], sell: ["ADMIN", "MANAGER", "STAFF"] } as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof permissions;
export const hasPermission = (role: Role, permission: Permission) =>
  (permissions[permission] as readonly Role[]).includes(role);

export const canManageProcurement = (role: Role) => hasPermission(role, "manageProcurement");

import { DexieOfflineStore } from "./db.ts";
import type { DeviceIdentity, DeviceIdentityStore } from "./types.ts";

type DeviceDependencies = { createId?: () => string; now?: () => string };

function createUuid() {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("Secure UUID generation is unavailable in this browser.");
  return id;
}

export async function getOrCreateDevice(store: DeviceIdentityStore, dependencies: DeviceDependencies = {}) {
  const existing = await store.getDevice();
  if (existing) return existing;
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  const device: DeviceIdentity = { id: (dependencies.createId ?? createUuid)(), createdAt: now, updatedAt: now };
  await store.saveDevice(device);
  return device;
}

let installationDevice: Promise<DeviceIdentity> | undefined;

export function getInstallationDevice() {
  installationDevice ??= getOrCreateDevice(new DexieOfflineStore());
  return installationDevice;
}

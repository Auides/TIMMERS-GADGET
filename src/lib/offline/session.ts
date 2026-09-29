import type { OfflineRole } from "./types.ts";

export const LAGOS_TIME_ZONE = "Africa/Lagos";
export const OFFLINE_INACTIVITY_MS = 60 * 60 * 1000;

export function lagosBusinessDate(value: string | Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: LAGOS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Africa/Lagos has a fixed UTC+01:00 offset; schedule a lock precisely at its next local midnight. */
export function millisecondsUntilNextLagosBusinessDate(value: string | Date) {
  const date = lagosBusinessDate(value);
  const [year, month, day] = date.split("-").map(Number);
  const nextMidnightUtc = Date.UTC(year, month - 1, day + 1) - 60 * 60 * 1000;
  return Math.max(0, nextMidnightUtc - new Date(value).getTime());
}

export function requiresOperationalRelock(role: OfflineRole, lastActivityAt: string, now: string) {
  if (role === "ADMIN") return false;
  return Date.parse(now) - Date.parse(lastActivityAt) >= OFFLINE_INACTIVITY_MS;
}

export function crossedLagosBusinessDate(role: OfflineRole, unlockedAt: string, now: string) {
  return role !== "ADMIN" && lagosBusinessDate(unlockedAt) !== lagosBusinessDate(now);
}

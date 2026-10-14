import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("authenticated profile resolution is request-memoized without weakening the proxy gate", () => {
  const authSource = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
  const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");

  assert.match(authSource, /import \{ cache \} from "react"/);
  assert.match(authSource, /export const getAuthoritativeProfileSnapshot = cache\(getAuthoritativeProfileSnapshotUncached\)/);
  assert.match(authSource, /export const getAuthenticatedProfile = cache\(async/);
  assert.doesNotMatch(authSource, /["']use cache(?:: (?:private|remote))?["']/);

  assert.match(proxySource, /supabase\.auth\.getUser\(\)/);
  assert.match(proxySource, /from\("profiles"\)\.select\("id, is_active"\)/);
  assert.match(proxySource, /if \(!profile\?\.is_active\) return NextResponse\.redirect/);
});

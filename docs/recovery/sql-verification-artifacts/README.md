# Recovered SQL verification artifact inventory

## Preservation rule

These files are historical recovery evidence. Do not execute them against production as part of Phase 0, do not silently rewrite them, and do not move the originals. This directory is the proposed version-controlled documentation location for future reviewed copies, if copying is required without losing original provenance.

## Phase 6 tracked artifacts

| Source artifact | Classification |
| --- | --- |
| `supabase/phase6-legacy-preflight-readonly.sql` | Read-only preflight |
| `supabase/phase6-migration2-live-verification-readonly.sql` | Read-only verifier |
| `supabase/phase6-migration3-live-verification-readonly.sql` | Read-only verifier |
| `supabase/phase6-migration3-four-fail-diagnostic-readonly.sql` | Read-only diagnostic |
| `supabase/phase6-migration3-live-behavioral-verification-rollback.sql` | Rollback-based behavioural test |
| `supabase/phase6-migration3-two-fail-behavioral-diagnostic-rollback.sql` | Rollback-based behavioural diagnostic |

## Phase 7 locally excluded artifacts

The following are intentionally excluded by the local `.git/info/exclude` rule `supabase/phase7-*`; the root `phase7-*.txt` outputs are excluded by the same local recovery convention. They remain preserved locally and are not moved.

| Source artifact | Classification |
| --- | --- |
| `supabase/phase7-legacy-preflight-readonly.sql` | Read-only preflight |
| `supabase/phase7-migration1-live-verification-readonly.sql` | Read-only verifier |
| `supabase/phase7-migration2-live-verification-readonly.sql` | Read-only verifier |
| `supabase/phase7-migration2-failure-diagnostics-readonly.sql` | Read-only diagnostic |
| `supabase/phase7-migration3a-live-verification-readonly.sql` | Read-only verifier |
| `supabase/phase7-migration3b-live-verification-readonly.sql` | Read-only verifier |
| `supabase/phase7-migration3b-correction-live-verification-readonly.sql` | Read-only verifier |
| `supabase/phase7-migration3c-two-fail-diagnostic-readonly.sql` | Read-only diagnostic |
| `supabase/phase7-migration3c-live-verification-readonly.sql` | Read-only verifier |
| `supabase/phase7-migration3c-live-behavioral-verification-rollback.sql` | Rollback-based behavioural test |
| `phase7-preflight-output.txt` | Captured preflight output |
| `phase7-preflight-full.txt` | Captured preflight output |

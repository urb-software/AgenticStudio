-- Issue #72: a structured marker for an operation cut off by a crash or a restart of Studio.
-- A failed Repository gains the reason code `interrupted`, which replaces the earlier
-- `unknown` failure with the fixed detail 'Interrupted'. Additive: every stored code stays
-- valid, and the rows written the earlier way are moved to the new code (with no detail).

ALTER TABLE "repositories" DROP CONSTRAINT "repositories_failure_code_check";
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_failure_code_check"
    CHECK ("failure_code" IN ('auth_failed', 'host_unreachable', 'host_key_mismatch', 'repository_not_found', 'branch_not_found', 'timeout', 'size_limit', 'remote_not_allowed', 'redirect_refused', 'interrupted', 'unknown'));
UPDATE "repositories" SET "failure_code" = 'interrupted', "failure_detail" = ''
    WHERE "failure_code" = 'unknown' AND "failure_detail" = 'Interrupted';

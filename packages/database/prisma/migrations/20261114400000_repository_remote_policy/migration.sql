-- Issue #69: the address policy for Git remotes. A failed Repository gains two reason codes:
-- remote_not_allowed (the remote host is, or resolves to, an address Studio does not connect
-- to) and redirect_refused (the remote answered with an HTTP redirect, which Studio never
-- follows). Additive: every stored code stays valid.

ALTER TABLE "repositories" DROP CONSTRAINT "repositories_failure_code_check";
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_failure_code_check"
    CHECK ("failure_code" IN ('auth_failed', 'host_unreachable', 'host_key_mismatch', 'repository_not_found', 'branch_not_found', 'timeout', 'size_limit', 'remote_not_allowed', 'redirect_refused', 'unknown'));

-- The Project's merge method: how Studio asks the Git host to merge its Runs' pull requests.
-- Existing Projects become 'squash', the only method until now. A Merge approval may now record
-- 'merge_commit' too.
-- Rollback: set projects with merge_method 'merge_commit' to 'squash' and delete or rewrite the
-- merge_approvals with method 'merge_commit', restore merge_approvals_method_check as
-- CHECK ("method" IN ('squash')), then drop the constraint and the column of projects.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "merge_method" VARCHAR(16) NOT NULL DEFAULT 'squash';

ALTER TABLE "projects" ADD CONSTRAINT "projects_merge_method_check"
    CHECK ("merge_method" IN ('squash', 'merge_commit'));

ALTER TABLE "merge_approvals" DROP CONSTRAINT "merge_approvals_method_check";

ALTER TABLE "merge_approvals" ADD CONSTRAINT "merge_approvals_method_check"
    CHECK ("method" IN ('squash', 'merge_commit'));

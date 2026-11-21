import type { MergeApprovalOutput } from '../../../platform/api';

const LABELS: Record<MergeApprovalOutput['method'], string> = {
  squash: 'Squash',
  merge_commit: 'Merge commit',
};

/** How a merge method reads on the Run page. */
export function mergeMethodLabel(method: MergeApprovalOutput['method']): string {
  return LABELS[method];
}

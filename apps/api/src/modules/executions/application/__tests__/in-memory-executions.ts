import { InMemoryPreparedFollowUpRepository } from '../../domain/repositories/__tests__/in-memory-prepared-follow-up-repository.js';
import { InMemoryReviewCommentRepository } from '../../domain/repositories/__tests__/in-memory-review-comment-repository.js';
import { InMemoryRunDiffRepository } from '../../domain/repositories/__tests__/in-memory-run-diff-repository.js';
import { InMemoryRunLookupRepository } from '../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunLookupRequests } from '../run-lookup-requests.js';
import { InMemoryRunTransactions } from '../ports/__tests__/in-memory-run-transactions.js';

export function inMemoryExecutions(runs: InMemoryRunRepository = new InMemoryRunRepository()) {
  const lookups = new InMemoryRunLookupRepository(runs);
  const preparedFollowUps = new InMemoryPreparedFollowUpRepository(runs);
  const reviewComments = new InMemoryReviewCommentRepository(runs);
  const diffs = new InMemoryRunDiffRepository();
  const transactions = new InMemoryRunTransactions({
    runs,
    lookups,
    reviewComments,
    preparedFollowUps,
    diffs,
  });
  return {
    runs,
    lookups,
    preparedFollowUps,
    reviewComments,
    diffs,
    transactions,
    requests: new RunLookupRequests(transactions),
  };
}

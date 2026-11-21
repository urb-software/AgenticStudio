/** Why Studio cannot merge or close a pull request, as a sentence that ends a clause. */
export const MERGE_UNAVAILABLE_REASON = {
  not_configured: "Studio's Merge credential is not configured.",
  unsupported_host: "this run's Git host is not supported.",
} as const;

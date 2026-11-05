import { hashKey } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Features show each other's data: a hike shows its trail and group, the hike form lists trails,
 * members and guests, statistics add up trails and hikes. Each feature caches that under its own
 * keys, so a change in one must refresh all of them, or the others show old data for a while.
 */
const SHARED_KEYS = ["trails", "hikes", "groups", "stats"];

/** `upToDate` is a query the caller has just filled with the server's answer. */
export function invalidateSharedData(
  queryClient: QueryClient,
  upToDate?: QueryKey,
): Promise<unknown> {
  const skipped = upToDate && hashKey(upToDate);
  return Promise.all(
    SHARED_KEYS.map((key) =>
      queryClient.invalidateQueries({
        queryKey: [key],
        predicate: (query) => query.queryHash !== skipped,
      }),
    ),
  );
}

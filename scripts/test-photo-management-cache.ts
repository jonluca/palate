import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import ts from "typescript";
import { queryKeys } from "../utils/query-keys.ts";
import { invalidateVisitListPageQueries, invalidateVisitStatusQueries } from "../utils/query-cache-policy.ts";

interface PhotoMutationOptions {
  onSettled: (
    result: { movedCount: number; fromVisitIds: string[] } | { removedCount: number },
  ) => void | Promise<void>;
}

interface PhotoMutationHooks {
  useAddPhotosToVisit?: (id: string) => PhotoMutationOptions;
  useRemovePhotosFromVisit?: (id: string) => PhotoMutationOptions;
}

// Load the production hooks while replacing only React and the database boundary.
const source = readFileSync(new URL("../hooks/queries.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("queries.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["invalidateVisitQueries", "useAddPhotosToVisit", "useRemovePhotosFromVisit"]);
const hookSource = sourceFile.statements
  .filter((statement) => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text ?? ""))
  .map((statement) => statement.getText(sourceFile))
  .join("\n");
assert.equal(hookSource.match(/function /g)?.length, 3);
const compiled = ts.transpileModule(hookSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const operation of ["add", "remove"] as const) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const loaded: PhotoMutationHooks = {};
  runInNewContext(compiled, {
    exports: loaded,
    useMutation: (options: PhotoMutationOptions) => options,
    useQueryClient: () => client,
    queryKeys,
    invalidateVisitListPageQueries,
    invalidateVisitStatusQueries,
  });
  assert.ok(loaded.useAddPhotosToVisit && loaded.useRemovePhotosFromVisit);

  const destination = queryKeys.visitDetail("destination");
  const sourceVisit = queryKeys.visitDetail("source");
  const destinationRestaurant = queryKeys.restaurantVisits("destination-restaurant");
  const sourceRestaurant = queryKeys.restaurantVisits("source-restaurant");
  const probes = [
    destination,
    destinationRestaurant,
    queryKeys.confirmedRestaurants,
    queryKeys.wrapped(2026),
    queryKeys.pendingReview,
  ];
  if (operation === "add") {
    probes.push(sourceVisit, sourceRestaurant);
  }
  for (const key of probes) {
    client.setQueryData(key, { version: "old" });
  }
  client.setQueryData(queryKeys.visitPages("all"), {
    pages: [{ version: "old" }, { version: "old-page-2" }],
    pageParams: [null, "cursor"],
  });
  const observer = new QueryObserver(client, {
    queryKey: destinationRestaurant,
    queryFn: async () => ({ version: "updated" }),
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const options =
      operation === "add" ? loaded.useAddPhotosToVisit("destination") : loaded.useRemovePhotosFromVisit("destination");
    await options.onSettled(operation === "add" ? { movedCount: 1, fromVisitIds: ["source"] } : { removedCount: 1 });
    // Flush the existing fire-and-forget invalidations as well as returned work.
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const key of probes.filter((key) => key !== destinationRestaurant)) {
      assert.equal(
        client.getQueryState(key)?.isInvalidated,
        true,
        `${operation}: refresh ${JSON.stringify(key)} after photo ownership changes`,
      );
    }
    assert.deepEqual(
      observer.getCurrentResult().data,
      { version: "updated" },
      `${operation}: mounted restaurant history must refresh its counts and previews`,
    );
    assert.equal(
      client.getQueryData<{ pages: unknown[] }>(queryKeys.visitPages("all"))?.pages.length,
      1,
      "Keep paging invalidation bounded to the first page",
    );
  } finally {
    unsubscribe();
    client.clear();
  }
}
console.log(
  "Photo-management cache regressions passed: destination/source visits, restaurant previews, and paged lists.",
);

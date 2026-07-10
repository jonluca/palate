#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/query-core";
import {
  invalidateVisitStatusQueries,
  WRAPPED_QUERY_KEY as PRODUCTION_WRAPPED_QUERY_KEY,
} from "../utils/query-cache-policy.ts";

export const WRAPPED_QUERY_PREFIX = PRODUCTION_WRAPPED_QUERY_KEY;
export const ALL_TIME_WRAPPED_QUERY_KEY = ["wrapped"] as const;
export const SELECTED_YEAR_WRAPPED_QUERY_KEY = ["wrapped", 2025] as const;

interface WrappedQueryData {
  readonly generation: number;
  readonly scope: "all-time" | "selected-year";
}

export interface ProductionPolicyContract {
  readonly rootStaleTimeMilliseconds: number;
  readonly productionPathnameRefetchSites: number;
  readonly wrappedInfiniteStaleSites: number;
  readonly allTimeSqlCalls: number;
  readonly selectedYearSqlCalls: number;
  readonly getAllCallSites: number;
  readonly getFirstCallSites: number;
  readonly allTimeOnlyCallSites: number;
  readonly allTimeObserverSites: number;
  readonly selectedYearObserverSites: number;
  readonly visitStatusInvalidatorDefinitions: number;
  readonly wrappedInvalidationsInVisitStatusHelper: number;
  readonly singleConfirmInvalidatorSites: number;
  readonly quickStatusInvalidatorSites: number;
}

export interface WrappedQueryCounters {
  readonly allTimeMaterializations: number;
  readonly selectedYearMaterializations: number;
  readonly weightedSqlCalls: number;
}

export type QueryPolicyMode = "legacy" | "candidate";

export interface MountedWrappedQueries {
  readonly queryClient: QueryClient;
  snapshot(): WrappedQueryCounters;
  markBothAgeStale(): void;
  legacyPathnameNavigation(): Promise<void>;
  candidatePathnameNavigation(): Promise<void>;
  setStatsFocused(focused: boolean): Promise<void>;
  invalidateForModeledMutation(): Promise<void>;
  candidateStatsFocus(): Promise<void>;
  bothQueriesInvalidated(): boolean;
  close(): void;
}

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

export function readProductionPolicyContract(rootDirectory = ROOT_DIRECTORY): ProductionPolicyContract {
  const rootLayout = readFileSync(resolve(rootDirectory, "app/_layout.tsx"), "utf8");
  const tabLayout = readFileSync(resolve(rootDirectory, "app/(app)/(tabs)/_layout.tsx"), "utf8");
  const queryHooks = readFileSync(resolve(rootDirectory, "hooks/queries.ts"), "utf8");
  const queryCachePolicy = readFileSync(resolve(rootDirectory, "utils/query-cache-policy.ts"), "utf8");
  const statsScreen = readFileSync(resolve(rootDirectory, "components/stats/stats-screen.tsx"), "utf8");
  const statsSource = readFileSync(resolve(rootDirectory, "utils/db/stats.ts"), "utf8");

  const wrappedFunctionMarker = "export async function getWrappedStats";
  const wrappedFunctionStart = statsSource.indexOf(wrappedFunctionMarker);
  assert.notEqual(wrappedFunctionStart, -1, "getWrappedStats production function must exist");
  const wrappedFunctionSource = statsSource.slice(wrappedFunctionStart);

  const getAllCallSites = countMatches(wrappedFunctionSource, /database\.getAllAsync\s*</g);
  const getFirstCallSites = countMatches(wrappedFunctionSource, /database\.getFirstAsync\s*</g);
  const allTimeOnlyCallSites = countMatches(
    wrappedFunctionSource,
    /year\s*\?\s*Promise\.resolve\(\[\]\)\s*:\s*database\.getAllAsync\s*<WrappedStatsYearlyQueryRow>/g,
  );
  const allTimeSqlCalls = getAllCallSites + getFirstCallSites;
  const selectedYearSqlCalls = allTimeSqlCalls - allTimeOnlyCallSites;

  const contract: ProductionPolicyContract = {
    rootStaleTimeMilliseconds: /staleTime:\s*1000\s*\*\s*30/.test(rootLayout) ? 30_000 : -1,
    productionPathnameRefetchSites: countMatches(
      tabLayout,
      /queryClient\.refetchQueries\(\{\s*type:\s*["']active["']\s*,\s*stale:\s*true\s*\}\)/g,
    ),
    wrappedInfiniteStaleSites: countMatches(
      queryHooks.slice(
        queryHooks.indexOf("export function useWrappedStats"),
        queryHooks.indexOf("export function useMichelinStatsBucketRestaurants"),
      ),
      /staleTime:\s*Infinity/g,
    ),
    allTimeSqlCalls,
    selectedYearSqlCalls,
    getAllCallSites,
    getFirstCallSites,
    allTimeOnlyCallSites,
    allTimeObserverSites: countMatches(statsScreen, /useWrappedStats\(null\s*,\s*\{\s*enabled:\s*isFocused\s*\}\)/g),
    selectedYearObserverSites: countMatches(
      statsScreen,
      /useWrappedStats\(selectedYear\s*,\s*\{\s*enabled:\s*isFocused\s*&&\s*selectedYear\s*!==\s*null\s*,?\s*\}\)/g,
    ),
    visitStatusInvalidatorDefinitions: countMatches(
      queryCachePolicy,
      /export function invalidateVisitStatusQueries\s*\(/g,
    ),
    wrappedInvalidationsInVisitStatusHelper: countMatches(
      queryCachePolicy.slice(
        queryCachePolicy.indexOf("export function invalidateVisitStatusQueries"),
        queryCachePolicy.indexOf("export function invalidateWrappedStatsQueries"),
      ),
      /invalidateQueries\(\{\s*queryKey:\s*WRAPPED_QUERY_KEY\s*\}\)/g,
    ),
    singleConfirmInvalidatorSites: countMatches(
      queryHooks.slice(
        queryHooks.indexOf("export function useConfirmVisit"),
        queryHooks.indexOf("export function useBatchConfirmVisits"),
      ),
      /invalidateVisitStatusQueries\(queryClient\)/g,
    ),
    quickStatusInvalidatorSites: countMatches(
      queryHooks.slice(
        queryHooks.indexOf("export function useQuickUpdateVisitStatus"),
        queryHooks.indexOf("export function useUndoVisitAction"),
      ),
      /invalidateVisitStatusQueries\(queryClient\)/g,
    ),
  };

  assert.deepEqual(
    contract,
    {
      rootStaleTimeMilliseconds: 30_000,
      productionPathnameRefetchSites: 0,
      wrappedInfiniteStaleSites: 1,
      allTimeSqlCalls: 20,
      selectedYearSqlCalls: 19,
      getAllCallSites: 10,
      getFirstCallSites: 10,
      allTimeOnlyCallSites: 1,
      allTimeObserverSites: 1,
      selectedYearObserverSites: 1,
      visitStatusInvalidatorDefinitions: 1,
      wrappedInvalidationsInVisitStatusHelper: 1,
      singleConfirmInvalidatorSites: 1,
      quickStatusInvalidatorSites: 1,
    },
    "production tab/Stats/query-call structure changed; update the isolated policy model intentionally",
  );

  return contract;
}

async function waitForBothIdle(
  allTime: QueryObserver<WrappedQueryData>,
  selectedYear: QueryObserver<WrappedQueryData>,
) {
  const deadline = performance.now() + 2_000;
  while (allTime.getCurrentResult().fetchStatus !== "idle" || selectedYear.getCurrentResult().fetchStatus !== "idle") {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for modeled Wrapped Stats queries");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function mountWrappedQueries(
  contract: ProductionPolicyContract,
  mode: QueryPolicyMode,
): Promise<MountedWrappedQueries> {
  const wrappedStaleTime = mode === "legacy" ? contract.rootStaleTimeMilliseconds : Infinity;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: contract.rootStaleTimeMilliseconds,
      },
    },
  });
  let allTimeMaterializations = 0;
  let selectedYearMaterializations = 0;
  let weightedSqlCalls = 0;

  const allTimeOptions: QueryObserverOptions<WrappedQueryData> = {
    queryKey: ALL_TIME_WRAPPED_QUERY_KEY,
    staleTime: wrappedStaleTime,
    enabled: true,
    queryFn: async () => {
      allTimeMaterializations += 1;
      weightedSqlCalls += contract.allTimeSqlCalls;
      return { generation: allTimeMaterializations, scope: "all-time" };
    },
  };
  const selectedYearOptions: QueryObserverOptions<WrappedQueryData> = {
    queryKey: SELECTED_YEAR_WRAPPED_QUERY_KEY,
    staleTime: wrappedStaleTime,
    enabled: true,
    queryFn: async () => {
      selectedYearMaterializations += 1;
      weightedSqlCalls += contract.selectedYearSqlCalls;
      return { generation: selectedYearMaterializations, scope: "selected-year" };
    },
  };

  const allTimeObserver = new QueryObserver(queryClient, allTimeOptions);
  const selectedYearObserver = new QueryObserver(queryClient, selectedYearOptions);
  const unsubscribeAllTime = allTimeObserver.subscribe(() => undefined);
  const unsubscribeSelectedYear = selectedYearObserver.subscribe(() => undefined);
  await waitForBothIdle(allTimeObserver, selectedYearObserver);

  const setStatsFocused = async (focused: boolean) => {
    allTimeObserver.setOptions({ ...allTimeOptions, enabled: focused });
    selectedYearObserver.setOptions({ ...selectedYearOptions, enabled: focused });
    await waitForBothIdle(allTimeObserver, selectedYearObserver);
  };

  return {
    queryClient,
    snapshot: () => ({ allTimeMaterializations, selectedYearMaterializations, weightedSqlCalls }),
    markBothAgeStale: () => {
      const staleUpdatedAt = Date.now() - contract.rootStaleTimeMilliseconds - 1;
      const allTimeData = queryClient.getQueryData<WrappedQueryData>(ALL_TIME_WRAPPED_QUERY_KEY);
      const selectedYearData = queryClient.getQueryData<WrappedQueryData>(SELECTED_YEAR_WRAPPED_QUERY_KEY);
      assert.ok(allTimeData, "all-time query must be populated before aging it");
      assert.ok(selectedYearData, "selected-year query must be populated before aging it");
      queryClient.setQueryData(ALL_TIME_WRAPPED_QUERY_KEY, allTimeData, { updatedAt: staleUpdatedAt });
      queryClient.setQueryData(SELECTED_YEAR_WRAPPED_QUERY_KEY, selectedYearData, { updatedAt: staleUpdatedAt });
    },
    legacyPathnameNavigation: async () => {
      await queryClient.refetchQueries({ type: "active", stale: true });
      await waitForBothIdle(allTimeObserver, selectedYearObserver);
    },
    candidatePathnameNavigation: async () => {
      // Candidate policy: route changes do not sweep unrelated active queries.
      await Promise.resolve();
    },
    setStatsFocused,
    invalidateForModeledMutation: async () => {
      invalidateVisitStatusQueries(queryClient);
      const deadline = performance.now() + 2_000;
      while (
        queryClient.getQueryState(ALL_TIME_WRAPPED_QUERY_KEY)?.isInvalidated !== true ||
        queryClient.getQueryState(SELECTED_YEAR_WRAPPED_QUERY_KEY)?.isInvalidated !== true
      ) {
        if (performance.now() >= deadline) {
          throw new Error("Timed out waiting for production visit-status invalidation");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    candidateStatsFocus: async () => {
      await setStatsFocused(true);
    },
    bothQueriesInvalidated: () =>
      queryClient.getQueryState(ALL_TIME_WRAPPED_QUERY_KEY)?.isInvalidated === true &&
      queryClient.getQueryState(SELECTED_YEAR_WRAPPED_QUERY_KEY)?.isInvalidated === true,
    close: () => {
      unsubscribeAllTime();
      unsubscribeSelectedYear();
      queryClient.clear();
    },
  };
}

export function weightedSqlDelta(before: WrappedQueryCounters, after: WrappedQueryCounters): number {
  return after.weightedSqlCalls - before.weightedSqlCalls;
}

import { authClient } from "@/lib/auth-client";
import { getTrpcClient } from "@/lib/trpc";
import { getVisitsWithDetails } from "@/utils/db/visits";

export const cloudQueryKeys = {
  health: ["cloud", "health"] as const,
  profile: ["cloud", "profile"] as const,
  socialMe: ["cloud", "social", "me"] as const,
  socialSearch: (query: string) => ["cloud", "social", "search", query] as const,
  publicProfile: (userId: string) => ["cloud", "social", "profile", userId] as const,
};

function normalizeTimestamp(timestamp: number) {
  return Math.round(timestamp);
}

function isUnauthorizedError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    data?: {
      code?: string;
    };
    message?: string;
  };

  return candidate.data?.code === "UNAUTHORIZED" || candidate.message?.includes("UNAUTHORIZED") === true;
}

async function buildConfirmedVisitSyncPayload() {
  const visits = await getVisitsWithDetails("confirmed");

  return visits.map((visit) => ({
    localVisitId: visit.id,
    restaurantId: visit.restaurantId,
    restaurantName: visit.restaurantName ?? visit.suggestedRestaurantName ?? "Confirmed restaurant",
    startTime: normalizeTimestamp(visit.startTime),
    endTime: normalizeTimestamp(visit.endTime),
    centerLat: visit.centerLat,
    centerLon: visit.centerLon,
    photoCount: visit.photoCount,
    awardAtVisit: visit.awardAtVisit,
  }));
}

export async function syncConfirmedVisitsSnapshot(options?: { throwOnError?: boolean }) {
  if (!authClient.getCookie()) {
    return {
      skipped: true,
      syncedCount: 0,
    };
  }

  try {
    const visits = await buildConfirmedVisitSyncPayload();
    const result = await getTrpcClient().social.syncConfirmedVisits.mutate({ visits });

    return {
      skipped: false,
      syncedCount: result.syncedCount,
    };
  } catch (error) {
    if (!options?.throwOnError && isUnauthorizedError(error)) {
      return {
        skipped: true,
        syncedCount: 0,
      };
    }

    throw error;
  }
}

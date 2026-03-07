import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { authClient } from "@/lib/auth-client";
import { getApiBaseUrl } from "@/lib/api-config";
import type { AppRouter } from "@/server/trpc/router";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

let trpcClientSingleton: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;

export function createPalateQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 30,
        retry: false,
        refetchOnMount: (query) => {
          const queryKey = query.queryKey;
          const isStaticQuery = Array.isArray(queryKey) && queryKey[0] === "static";
          return isStaticQuery ? false : "always";
        },
      },
      mutations: {
        retry: 1,
      },
    },
  });
}

export function getTrpcClient() {
  if (trpcClientSingleton) {
    return trpcClientSingleton;
  }

  trpcClientSingleton = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${getApiBaseUrl()}/trpc`,
        headers() {
          const cookie = authClient.getCookie();

          return cookie ? { cookie } : {};
        },
      }),
    ],
  });

  return trpcClientSingleton;
}

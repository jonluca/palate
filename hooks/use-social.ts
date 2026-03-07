import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { cloudQueryKeys } from "@/lib/cloud-sync";
import { useTRPCClient } from "@/lib/trpc";

function toError(error: unknown) {
  return error instanceof Error ? error : new Error("Something went wrong.");
}

function invalidateSocialCollections(queryClient: QueryClient, targetUserId?: string) {
  queryClient.invalidateQueries({ queryKey: cloudQueryKeys.profile });
  queryClient.invalidateQueries({ queryKey: cloudQueryKeys.socialMe });
  queryClient.invalidateQueries({ queryKey: cloudQueryKeys.socialFeed });

  if (targetUserId) {
    queryClient.invalidateQueries({ queryKey: cloudQueryKeys.publicProfile(targetUserId) });
  }
}

function invalidateVisitThread(
  queryClient: QueryClient,
  args: {
    visitUserId: string;
    localVisitId: string;
  },
) {
  queryClient.invalidateQueries({ queryKey: cloudQueryKeys.socialFeed });
  queryClient.invalidateQueries({ queryKey: cloudQueryKeys.socialVisitComments(args.visitUserId, args.localVisitId) });
}

export function useSocialMe() {
  const trpcClient = useTRPCClient();
  const { data: session } = useSession();

  return useQuery({
    queryKey: cloudQueryKeys.socialMe,
    enabled: Boolean(session?.user),
    queryFn: () => trpcClient.social.me.query(),
  });
}

export function useSocialFeed() {
  const trpcClient = useTRPCClient();
  const { data: session } = useSession();

  return useQuery({
    queryKey: cloudQueryKeys.socialFeed,
    enabled: Boolean(session?.user),
    queryFn: () => trpcClient.social.feed.query(),
  });
}

export function useSocialSearch(query: string) {
  const trpcClient = useTRPCClient();
  const { data: session } = useSession();
  const trimmedQuery = query.trim();

  return useQuery({
    queryKey: cloudQueryKeys.socialSearch(trimmedQuery),
    enabled: Boolean(session?.user) && trimmedQuery.length >= 2,
    queryFn: () => trpcClient.social.search.query({ query: trimmedQuery }),
  });
}

export function usePublicProfile(userId?: string) {
  const trpcClient = useTRPCClient();

  return useQuery({
    queryKey: cloudQueryKeys.publicProfile(userId ?? ""),
    enabled: Boolean(userId),
    queryFn: () => trpcClient.social.publicProfile.query({ userId: userId! }),
  });
}

export function useVisitComments(args: { visitUserId: string; localVisitId: string; enabled?: boolean }) {
  const trpcClient = useTRPCClient();

  return useQuery({
    queryKey: cloudQueryKeys.socialVisitComments(args.visitUserId, args.localVisitId),
    enabled: (args.enabled ?? true) && Boolean(args.visitUserId) && Boolean(args.localVisitId),
    queryFn: () =>
      trpcClient.social.visitComments.query({
        visitUserId: args.visitUserId,
        localVisitId: args.localVisitId,
      }),
  });
}

export function useSetFollowState(callbacks?: { onSuccess?: () => void; onError?: (error: Error) => void }) {
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: ({ userId, isFollowing }: { userId: string; isFollowing: boolean }) =>
      isFollowing ? trpcClient.social.unfollow.mutate({ userId }) : trpcClient.social.follow.mutate({ userId }),
    onSuccess: (_result, variables) => {
      invalidateSocialCollections(queryClient, variables.userId);
      callbacks?.onSuccess?.();
    },
    onError: (error) => {
      callbacks?.onError?.(toError(error));
    },
  });
}

export function useSetVisitLike(callbacks?: { onSuccess?: () => void; onError?: (error: Error) => void }) {
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (args: { visitUserId: string; localVisitId: string; liked: boolean }) =>
      trpcClient.social.setVisitLike.mutate(args),
    onSuccess: (_result, variables) => {
      invalidateVisitThread(queryClient, variables);
      callbacks?.onSuccess?.();
    },
    onError: (error) => {
      callbacks?.onError?.(toError(error));
    },
  });
}

export function useAddVisitComment(callbacks?: { onSuccess?: () => void; onError?: (error: Error) => void }) {
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: (args: { visitUserId: string; localVisitId: string; body: string }) =>
      trpcClient.social.addVisitComment.mutate(args),
    onSuccess: (result, variables) => {
      invalidateVisitThread(queryClient, variables);
      queryClient.invalidateQueries({ queryKey: cloudQueryKeys.publicProfile(variables.visitUserId) });
      callbacks?.onSuccess?.();
      return result;
    },
    onError: (error) => {
      callbacks?.onError?.(toError(error));
    },
  });
}

export function useDeleteVisitComment(callbacks?: { onSuccess?: () => void; onError?: (error: Error) => void }) {
  const queryClient = useQueryClient();
  const trpcClient = useTRPCClient();

  return useMutation({
    mutationFn: ({ commentId }: { commentId: string }) => trpcClient.social.deleteVisitComment.mutate({ commentId }),
    onSuccess: (result) => {
      invalidateVisitThread(queryClient, result);
      queryClient.invalidateQueries({ queryKey: cloudQueryKeys.publicProfile(result.visitUserId) });
      callbacks?.onSuccess?.();
    },
    onError: (error) => {
      callbacks?.onError?.(toError(error));
    },
  });
}

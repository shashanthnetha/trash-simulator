// Trash Simulator – actor creation using the new Internet Identity sign-in.
// Still uses the platform's createActorWithConfig (canister ID, host, file
// transport), but takes the identity from our own provider.
import {
  type createActorFunction,
  createActorWithConfig,
} from "@caffeineai/core-infrastructure";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useInternetIdentity } from "../auth/internetIdentity";

const ACTOR_QUERY_KEY = "actor";

export function useActor<T>(createActor: createActorFunction<T>): {
  actor: T | null;
  isFetching: boolean;
} {
  const { identity, isAuthenticated, isInitializing } = useInternetIdentity();
  const queryClient = useQueryClient();

  const actorQuery = useQuery({
    queryKey: [ACTOR_QUERY_KEY, identity?.getPrincipal().toString() ?? "anon"],
    // Only start once the session state is settled – otherwise an anonymous
    // actor would briefly be created and thrown away again right after.
    enabled: !isInitializing,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<T> => {
      if (isAuthenticated && identity) {
        return await createActorWithConfig(createActor, {
          agentOptions: { identity },
        });
      }
      return await createActorWithConfig(createActor);
    },
  });

  // When the identity changes (login/logout) every domain query is stale –
  // refetch so that profile & co. match the new session.
  useEffect(() => {
    if (actorQuery.data) {
      const notActor = (q: { queryKey: readonly unknown[] }) =>
        !q.queryKey.includes(ACTOR_QUERY_KEY);
      void queryClient.invalidateQueries({ predicate: notActor });
      void queryClient.refetchQueries({ predicate: notActor });
    }
  }, [actorQuery.data, queryClient]);

  return {
    actor: actorQuery.data ?? null,
    isFetching: actorQuery.isFetching,
  };
}

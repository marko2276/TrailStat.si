import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../lib/api";

export interface Me {
  id: string;
  email: string;
  display_name: string;
  country: string | null;
  city: string | null;
  avatar_url: string | null;
  /** null until the user's language has been stored for the first time */
  locale: string | null;
}

export type MeUpdate = Partial<Pick<Me, "display_name" | "country" | "city">> & {
  locale?: string;
};

const ME_KEY = ["me"];

export function useMe() {
  const { status } = useAuth();
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api.get<Me>("/me"),
    enabled: status === "authenticated",
  });
}

export function useUpdateMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: MeUpdate) => api.patch<Me>("/me", update),
    onSuccess: (me) => queryClient.setQueryData(ME_KEY, me),
  });
}

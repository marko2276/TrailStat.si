import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

/** Totals only: the admin page shows nobody's data. */
export interface AdminStats {
  users: {
    total: number;
    new_7_days: number;
    new_30_days: number;
    /** Used the app on at least one of the last 30 days. */
    active_30_days: number;
    /** By language code; "unknown" before the first page was shown. */
    by_language: Record<string, number>;
  };
  content: {
    trails: number;
    trails_by_source: Record<string, number>;
    trails_by_visibility: Record<string, number>;
    trails_archived: number;
    hikes: number;
    hikes_30_days: number;
    groups: number;
    memberships: number;
    guests: number;
    pending_invitations: number;
    pending_join_requests: number;
  };
  database: {
    size_bytes: number;
    largest_tables: { name: string; size_bytes: number; rows_estimate: number }[];
    migration: string | null;
  };
  server: {
    version: string;
    environment: string;
    started_at: string;
    today: string;
    elevation_data: { tiles: number; size_bytes: number };
    email_configured: boolean;
    donations_bank_transfer: boolean;
    donations_flik: boolean;
  };
}

export function useAdminStats() {
  return useQuery({
    queryKey: ["admin", "stats"],
    queryFn: () => api.get<AdminStats>("/admin/stats"),
  });
}

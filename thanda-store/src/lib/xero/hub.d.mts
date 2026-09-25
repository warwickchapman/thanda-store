export function hubRequest(path: string, init?: RequestInit): Promise<Response>;
export function hubFetch(path: string | URL, init?: RequestInit): Promise<Response>;
export function hubStatus(): Promise<{
  connected: boolean; tenant_id: string; tenant_name: string; scope: string; expires_at: string;
  streams: Array<{ resource: string; complete: boolean; observed_at: string; last_error: string | null }>;
  budget: { day_remaining: number | null; minute_remaining: number | null; blocked_until: string | null; observed_at: string; limit_problem: string | null } | null;
  by_source: Array<{ source: string; calls: number }>;
}>;

export function assertHubSnapshot(payload: unknown, previous?: string): string;

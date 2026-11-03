import { vi } from "vitest";

type Reply = unknown | { status: number; body?: unknown };

function isExplicit(reply: Reply): reply is { status: number; body?: unknown } {
  return typeof reply === "object" && reply !== null && "status" in reply;
}

/**
 * Replaces fetch with fixed replies, keyed "METHOD /api/path" (with the query string, if any).
 * A request without a reply fails the test, instead of being silently ignored.
 *
 *   const api = mockApi({ "GET /api/me": me, "PATCH /api/me": { status: 500 } });
 *   api.bodyOf("PATCH /api/me") // the last JSON body sent
 */
export function mockApi(replies: Record<string, Reply>) {
  const requests: { key: string; body: unknown }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? "GET"} ${url}`;
      requests.push({ key, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (!(key in replies)) throw new Error(`mockApi: no reply for ${key}`);
      const reply = replies[key];
      const { status, body } = isExplicit(reply) ? reply : { status: 200, body: reply };
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }),
  );

  return {
    requests,
    bodyOf: (key: string) => requests.filter((request) => request.key === key).at(-1)?.body,
  };
}

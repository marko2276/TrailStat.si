import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, UNAUTHORIZED_EVENT, api, withQuery } from "./api";

vi.mock("../auth/hanko", () => ({ getSessionToken: () => "the-token" }));

function respond(status: number, body?: unknown) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("sends the session token and returns JSON", async () => {
    const fetchMock = respond(200, { id: 1 });

    await expect(api.get("/me")).resolves.toEqual({ id: 1 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/me");
    expect(init.headers.Authorization).toBe("Bearer the-token");
  });

  it("sends a JSON body", async () => {
    const fetchMock = respond(200, {});

    await api.patch("/me", { city: "Bled" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe('{"city":"Bled"}');
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("handles an empty 204 response", async () => {
    respond(204);
    await expect(api.delete("/trails/1")).resolves.toBeUndefined();
  });

  it("turns an error response into an ApiError with the code", async () => {
    respond(409, { detail: "trail_name_taken" });

    const error = await api.get("/trails").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "trail_name_taken" });
  });

  it("uses a generic code for validation errors and non-JSON responses", async () => {
    respond(422, { detail: [{ msg: "bad" }] });
    await expect(api.get("/x")).rejects.toMatchObject({ code: "request_failed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 502 })));
    await expect(api.get("/x")).rejects.toMatchObject({ status: 502, code: "request_failed" });
  });

  it("announces an expired session", async () => {
    respond(401, { detail: "invalid_token" });
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);

    await api.get("/me").catch(() => undefined);

    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("withQuery", () => {
  it("leaves out empty values and encodes the rest", () => {
    expect(withQuery("/trails", { q: "Šmarna gora", limit: 10, empty: "", none: null })).toBe(
      "/trails?q=%C5%A0marna+gora&limit=10",
    );
    expect(withQuery("/trails", {})).toBe("/trails");
  });

  it("keeps zero and false", () => {
    expect(withQuery("/x", { offset: 0, archived: false })).toBe("/x?offset=0&archived=false");
  });
});

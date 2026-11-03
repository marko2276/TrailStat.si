import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("shows ok when the API is ready", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    render(<App />);
    expect(await screen.findByText("API status: ok")).toBeTruthy();
  });

  it("shows unavailable when the API responds with an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<App />);
    expect(await screen.findByText("API status: unavailable")).toBeTruthy();
  });

  it("shows unavailable when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    render(<App />);
    expect(await screen.findByText("API status: unavailable")).toBeTruthy();
  });
});

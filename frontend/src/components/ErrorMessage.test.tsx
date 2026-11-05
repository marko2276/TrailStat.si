import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { render } from "../test/render";
import { ErrorMessage } from "./ErrorMessage";

describe("ErrorMessage", () => {
  it("translates a known code from the shared namespace", () => {
    render(<ErrorMessage error={new ApiError(403, "forbidden")} />);
    expect(screen.getByRole("alert").textContent).toBe("You are not allowed to do this.");
  });

  it("falls back to a generic message for an unknown code", () => {
    render(<ErrorMessage error={new ApiError(500, "made_up_code")} />);
    expect(screen.getByRole("alert").textContent).toBe("Something went wrong. Please try again.");
  });

  it("falls back to a generic message for errors that are not from the API", () => {
    render(<ErrorMessage error={new Error("network")} />);
    expect(screen.getByRole("alert").textContent).toBe("Something went wrong. Please try again.");
  });
});

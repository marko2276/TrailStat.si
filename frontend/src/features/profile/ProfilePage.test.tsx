import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockApi } from "../../test/mockApi";
import { render } from "../../test/render";
import { ProfilePage } from "./ProfilePage";

vi.mock("../../auth/hanko", () => ({
  getHanko: () => new Promise(() => undefined),
  getSessionToken: () => "token",
  isHankoConfigured: true,
}));

const me = {
  id: "1",
  email: "marko@example.com",
  display_name: "Marko",
  country: "SI",
  city: null,
  avatar_url: null,
  locale: "en",
};

describe("ProfilePage", () => {
  it("shows the current profile, with the e-mail address read-only", async () => {
    mockApi({ "GET /api/me": me });
    render(<ProfilePage />);

    const name = await screen.findByLabelText<HTMLInputElement>("Name or nickname");
    expect(name.value).toBe("Marko");
    expect(screen.getByLabelText<HTMLInputElement>("E-mail").disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>("Country").value).toBe("SI");
  });

  it("saves changes and clears optional fields", async () => {
    const api = mockApi({ "GET /api/me": me, "PATCH /api/me": { ...me, display_name: "Nick" } });
    render(<ProfilePage />);

    const name = await screen.findByLabelText("Name or nickname");
    await userEvent.clear(name);
    await userEvent.type(name, "Nick");
    await userEvent.selectOptions(screen.getByLabelText("Country"), "");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.bodyOf("PATCH /api/me")).toEqual({
        display_name: "Nick",
        country: null,
        city: null,
      }),
    );
    expect(await screen.findByText("Profile saved.")).toBeTruthy();
  });

  it("shows an error when saving fails", async () => {
    mockApi({
      "GET /api/me": me,
      "PATCH /api/me": { status: 500, body: { detail: "internal" } },
    });
    render(<ProfilePage />);

    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
  });
});

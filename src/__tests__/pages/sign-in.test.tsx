import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingApi } from "../../api/booking";
import { fakeAuth } from "../helpers/fake-auth";
import { installFakeBooking } from "../helpers/fake-booking";
import { renderAt } from "../helpers/render";

vi.mock("../../lib/supabase", async () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  supabase: {
    auth: (await import("../helpers/fake-auth")).fakeAuth,
    from: () => ({ select: () => ({ order: async () => ({ data: [], error: null }) }) }),
  },
}));

const url = () => screen.getByTestId("url").textContent;

beforeEach(() => fakeAuth.reset());
afterEach(() => vi.unstubAllGlobals());

// The page waits for the stored session before rendering, so find (wait), don't get.
async function sendCodeTo(email: string) {
  await userEvent.type(await screen.findByLabelText(/^Email/), email);
  await userEvent.click(screen.getByRole("button", { name: "Email me a code" }));
}

describe("sign-in with an email code", () => {
  it("emails a code, signs in with it, and goes where it was asked to", async () => {
    renderAt("/sign-in?next=/book/checkout?service=prp");
    await sendCodeTo("avery@example.com");

    expect(await screen.findByText(/We sent a code to avery@example.com/)).toBeInTheDocument();
    expect(fakeAuth.state.codesSentTo).toEqual(["avery@example.com"]);

    await userEvent.type(screen.getByLabelText("Code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(url()).toBe("/book/checkout?service=prp"));
    expect(fakeAuth.state.session?.user.email).toBe("avery@example.com");
  });

  it("says so when the code is wrong, and stays on the code step", async () => {
    renderAt("/sign-in");
    await sendCodeTo("avery@example.com");
    await userEvent.type(await screen.findByLabelText("Code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/That code is wrong or expired/)).toBeInTheDocument();
    expect(fakeAuth.state.session).toBeNull();
    expect(url()).toBe("/sign-in");
  });

  it("checks the email and the code before calling Auth", async () => {
    renderAt("/sign-in");
    await sendCodeTo("not-an-email");
    expect(await screen.findByText("Enter a valid email.")).toBeInTheDocument();
    expect(fakeAuth.state.codesSentTo).toEqual([]);

    await userEvent.clear(screen.getByLabelText(/^Email/));
    await sendCodeTo("avery@example.com");
    await userEvent.type(await screen.findByLabelText("Code"), "12ab");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter the digits from the email.")).toBeInTheDocument();
  });

  it("explains a rate limit instead of failing silently", async () => {
    fakeAuth.state.rateLimited = true;
    renderAt("/sign-in");
    await sendCodeTo("avery@example.com");
    expect(await screen.findByText(/Too many codes requested/)).toBeInTheDocument();
  });

  it("lets you fix a typo'd email and ask for a new code", async () => {
    renderAt("/sign-in");
    await sendCodeTo("avery@exmaple.com");
    await userEvent.click(await screen.findByRole("button", { name: "Use a different email" }));
    await userEvent.clear(screen.getByLabelText(/^Email/));
    await sendCodeTo("avery@example.com");
    await userEvent.click(await screen.findByRole("button", { name: "Send a new code" }));
    await waitFor(() => expect(fakeAuth.state.codesSentTo).toEqual(["avery@exmaple.com", "avery@example.com", "avery@example.com"]));
  });

  it("prefills the email passed in router state, never in the URL", async () => {
    renderAt("/sign-in", { email: "avery@example.com" });
    expect(await screen.findByLabelText(/^Email/)).toHaveValue("avery@example.com");
    expect(url()).not.toContain("avery");
  });

  it("never redirects off the app after sign-in", async () => {
    renderAt("/sign-in?next=//evil.example/phish");
    await sendCodeTo("avery@example.com");
    await userEvent.type(await screen.findByLabelText("Code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(url()).toBe("/book/services"));
  });

  it("skips the form when already signed in", async () => {
    fakeAuth.signInAs("avery@example.com");
    renderAt("/sign-in?next=/book/call?service=prp");
    await waitFor(() => expect(url()).toBe("/book/call?service=prp"));
  });
});

describe("the header", () => {
  it("offers sign-in, coming back to the same page", async () => {
    renderAt("/book/call?service=prp");
    await userEvent.click(await screen.findByRole("link", { name: "Sign in" }));
    expect(url()).toBe("/sign-in?next=%2Fbook%2Fcall%3Fservice%3Dprp");
  });

  it("signs out", async () => {
    fakeAuth.signInAs("avery@example.com");
    renderAt("/book/services");
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(fakeAuth.state.session).toBeNull();
  });
});

describe("booking calls", () => {
  it("carry the access token when signed in, and only the publishable key when not", async () => {
    const fake = installFakeBooking();
    await bookingApi.start("noho", "prp");
    fakeAuth.signInAs("avery@example.com");
    await bookingApi.start("noho", "prp");

    expect(fake.state.calls.map((c) => c.headers.get("authorization"))).toEqual([null, "Bearer token-for-avery@example.com"]);
    expect(fake.state.calls.every((c) => c.headers.get("apikey") === "sb_publishable_test")).toBe(true);
  });
});

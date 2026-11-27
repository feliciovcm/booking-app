import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAuth } from "../helpers/fake-auth";
import { installFakeBooking } from "../helpers/fake-booking";
import { renderAt } from "../helpers/render";

// The page reads bookings straight from Postgres (RLS: own rows) and calls our booking
// function to claim guest bookings first. Both are faked; the query records its filters.
const db = vi.hoisted(() => ({ rows: [] as unknown[], filters: [] as unknown[][], error: null as unknown }));
vi.mock("../../lib/supabase", async () => {
  const query = {
    select: (...args: unknown[]) => (db.filters.push(["select", ...args]), query),
    eq: (...args: unknown[]) => (db.filters.push(["eq", ...args]), query),
    in: (...args: unknown[]) => (db.filters.push(["in", ...args]), query),
    order: async (...args: unknown[]) => (db.filters.push(["order", ...args]), { data: db.error ? null : db.rows, error: db.error }),
  };
  return {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    supabase: { auth: (await import("../helpers/fake-auth")).fakeAuth, from: () => query },
  };
});

const url = () => screen.getByTestId("url").textContent;
const NOHO = { name: "NYC Noho", timezone: "America/New_York" };
const row = (id: string, status: string, slot_start: string, location = NOHO) => ({
  id,
  status,
  slot_start,
  treatments: { name: "PRP Hair Restoration" },
  locations: location,
});

let fake: ReturnType<typeof installFakeBooking>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T15:00:00Z"));
  fakeAuth.reset();
  db.rows = [];
  db.filters = [];
  db.error = null;
  fake = installFakeBooking();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("My bookings", () => {
  it("sends you to sign in first, and back here after", async () => {
    renderAt("/my-bookings");
    await waitFor(() => expect(url()).toBe("/sign-in?next=%2Fmy-bookings"));
  });

  it("claims your guest bookings, then lists yours: upcoming first, in the clinic's time", async () => {
    fakeAuth.signInAs("avery@example.com");
    db.rows = [
      row("b-past", "confirmed", "2026-11-10T19:00:00.000Z"),
      row("b-next", "confirmed", "2026-11-26T15:00:00.000Z"),
      row("b-cancelled", "cancelled", "2026-11-28T20:00:00.000Z"),
    ];
    renderAt("/my-bookings");

    const upcoming = await screen.findByRole("region", { name: "Upcoming" });
    expect(within(upcoming).getByText("Thu, Nov 26 at 10:00 AM")).toBeInTheDocument();
    expect(within(upcoming).getByText("PRP Hair Restoration at NYC Noho")).toBeInTheDocument();

    const past = screen.getByRole("region", { name: "Past and cancelled" });
    expect(within(past).getByText("Tue, Nov 10 at 2:00 PM")).toBeInTheDocument();
    expect(within(past).getByText("Sat, Nov 28 at 3:00 PM")).toBeInTheDocument();
    expect(within(past).getByText("Cancelled")).toBeInTheDocument();

    // The claim ran first, as this user.
    expect(fake.state.calls.map((c) => [c.action, c.headers.get("authorization")])).toEqual([["claim", "Bearer token-for-avery@example.com"]]);
  });

  it("asks for your rows explicitly, not only through RLS, and never held or expired ones", async () => {
    fakeAuth.signInAs("avery@example.com");
    renderAt("/my-bookings");
    await screen.findByText(/No bookings yet/);
    expect(db.filters).toContainEqual(["eq", "user_id", "u-avery@example.com"]);
    expect(db.filters).toContainEqual(["in", "status", ["confirmed", "cancelled"]]);
  });

  it("shows an empty state with a way to book", async () => {
    fakeAuth.signInAs("avery@example.com");
    renderAt("/my-bookings");
    expect(await screen.findByText(/No bookings yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Book a treatment" })).toHaveAttribute("href", "/book/services");
  });

  it("still lists what it can when the claim fails, and says some may be missing", async () => {
    fakeAuth.signInAs("avery@example.com");
    fake.state.next.claim = [fake.error(503, "UNAVAILABLE")];
    db.rows = [row("b-next", "confirmed", "2026-11-26T15:00:00.000Z")];
    renderAt("/my-bookings");

    expect(await screen.findByText("Thu, Nov 26 at 10:00 AM")).toBeInTheDocument();
    expect(screen.getByText(/Bookings you made before signing in may be missing/)).toBeInTheDocument();
  });

  it("explains when the list can't load", async () => {
    fakeAuth.signInAs("avery@example.com");
    db.error = { message: "permission denied" };
    renderAt("/my-bookings");
    expect(await screen.findByText(/couldn't load your bookings/)).toBeInTheDocument();
  });

  it("leaves the page when you sign out on it, so your list doesn't stay on screen", async () => {
    fakeAuth.signInAs("avery@example.com");
    db.rows = [row("b-next", "confirmed", "2026-11-26T15:00:00.000Z")];
    renderAt("/my-bookings");
    await screen.findByText("Thu, Nov 26 at 10:00 AM");

    (await screen.findByRole("button", { name: "Sign out" })).click();
    await waitFor(() => expect(url()).toBe("/sign-in?next=%2Fmy-bookings"));
    expect(screen.queryByText("Thu, Nov 26 at 10:00 AM")).not.toBeInTheDocument();
  });

  it("is linked from the header when signed in", async () => {
    fakeAuth.signInAs("avery@example.com");
    renderAt("/sign-in?next=%2Fmy-bookings");
    await waitFor(() => expect(url()).toBe("/my-bookings"));
    expect(await screen.findByRole("link", { name: "My bookings" })).toHaveAttribute("href", "/my-bookings");
  });
});

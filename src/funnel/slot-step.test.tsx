import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeBooking } from "../test/fake-booking";
import { renderAt } from "../test/render";

// Catalog reads come from a fake supabase client; booking calls go to a fake `booking`
// function behind global fetch.
vi.mock("../lib/supabase", () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  supabase: {
    from: (table: string) => ({
      select: () => ({
        order: async () => ({
          data:
            table === "treatments"
              ? [{ id: "t1", slug: "prp", name: "PRP Hair Restoration", description: "", price_cents: 49500, session_count: 3 }]
              : [{ id: "l1", slug: "noho", name: "NYC Noho", address: "304 Mulberry St", timezone: "America/New_York" }],
          error: null,
        }),
      }),
    }),
  },
}));

let fake: ReturnType<typeof installFakeBooking>;
const SLOT_URL = "/book/slot?service=prp&location=noho";
const url = () => screen.getByTestId("url").textContent;
const calls = (action: string) => fake.state.calls.filter((c) => c.action === action);

beforeEach(() => {
  // Only Date is faked: "today" is fixed, timers stay real for React and Testing Library.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T15:00:00Z")); // 10:00 AM in New York
  sessionStorage.clear();
  fake = installFakeBooking();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SlotStep", () => {
  it("starts one session and lists two weeks of days, without loading times yet", async () => {
    renderAt(SLOT_URL);
    expect(await screen.findByRole("button", { name: "Wed, Nov 25" })).toBeInTheDocument();
    expect(calls("start")).toHaveLength(1);
    expect(calls("start")[0].body).toEqual({ action: "start", location: "noho", service: "prp" });
    expect(calls("dates")[0].body).toMatchObject({ sessionId: "fake|s1", from: "2026-11-24", to: "2026-12-07" });
    expect(calls("times")).toHaveLength(0); // Boulevard: query times only after the visitor picks a day

    const { headers } = calls("start")[0];
    expect(headers.get("apikey")).toBe("sb_publishable_test");
    expect(headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("puts the chosen day in the URL and shows times in the clinic's time zone", async () => {
    renderAt(SLOT_URL);
    await userEvent.click(await screen.findByRole("button", { name: "Wed, Nov 25" }));
    expect(url()).toBe(`${SLOT_URL}&date=2026-11-25`);
    const times = await screen.findByRole("list", { name: "Times on Wed, Nov 25" });
    expect(within(times).getAllByRole("button").map((b) => b.textContent)).toEqual(["9:00 AM", "10:00 AM"]);
  });

  it("loads times straight away for a deep link that already has a day", async () => {
    renderAt(`${SLOT_URL}&date=2026-11-25`);
    expect(await screen.findByRole("button", { name: "9:00 AM" })).toBeInTheDocument();
  });

  it("holds a time and says for how long", async () => {
    renderAt(`${SLOT_URL}&date=2026-11-25`);
    await userEvent.click(await screen.findByRole("button", { name: "9:00 AM" }));
    expect(await screen.findByRole("heading", { name: "Wed, Nov 25 at 9:00 AM" })).toBeInTheDocument();
    expect(screen.getByText("We'll keep this time for you for 30 minutes.")).toBeInTheDocument();
    expect(calls("hold")[0].body).toEqual({ action: "hold", sessionId: "fake|s1", slotId: "t1" });
  });

  it("explains when someone else got the time, and refreshes the list", async () => {
    renderAt(`${SLOT_URL}&date=2026-11-25`);
    const nine = await screen.findByRole("button", { name: "9:00 AM" });
    fake.state.taken.add("t1"); // another visitor books 9:00 meanwhile
    await userEvent.click(nine);

    expect(await screen.findByRole("alert")).toHaveTextContent("Time is no longer available, please select another.");
    await waitFor(() => expect(screen.queryByRole("button", { name: "9:00 AM" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeInTheDocument();
  });

  it("starts a new session when the old one expired", async () => {
    sessionStorage.setItem("booking-session:prp:noho", "fake|old");
    fake.state.next.dates = [fake.error(409, "SESSION_EXPIRED")];
    renderAt(SLOT_URL);

    expect(await screen.findByRole("button", { name: "Wed, Nov 25" })).toBeInTheDocument();
    expect(calls("dates").map((c) => c.body.sessionId)).toEqual(["fake|old", "fake|s1"]);
    expect(sessionStorage.getItem("booking-session:prp:noho")).toBe("fake|s1");
  });

  it("reuses the session after a refresh instead of starting another", async () => {
    const first = renderAt(SLOT_URL);
    await screen.findByRole("button", { name: "Wed, Nov 25" });
    first.unmount();

    renderAt(SLOT_URL);
    await screen.findByRole("button", { name: "Wed, Nov 25" });
    expect(calls("start")).toHaveLength(1);
  });

  it("retries when the booking service is briefly unavailable", async () => {
    fake.state.next.dates = [fake.error(503, "UNAVAILABLE")];
    renderAt(SLOT_URL);
    expect(await screen.findByRole("button", { name: "Wed, Nov 25" }, { timeout: 3000 })).toBeInTheDocument();
    expect(calls("dates")).toHaveLength(2);
  });

  it("offers a call when the treatment can't be booked online here", async () => {
    fake.state.next.start = [fake.error(404, "NOT_BOOKABLE", "This treatment can't be booked online at this clinic.")];
    renderAt(SLOT_URL);
    expect(await screen.findByRole("alert")).toHaveTextContent("This treatment can't be booked online at this clinic.");
    expect(screen.getByRole("link", { name: "Request a call instead" })).toHaveAttribute("href", "/book/call");
  });

  it("offers a call when there are no openings", async () => {
    fake.state.dates = [];
    renderAt(SLOT_URL);
    expect(await screen.findByText("No openings in the next two weeks.")).toBeInTheDocument();
  });
});

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeBooking } from "../test/fake-booking";
import { renderAt } from "../test/render";

// A tiny fake of the supabase-js calls this app makes. It records inserts and
// whether .select() was chained after one (the RLS gotcha on consult_requests).
const fake = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  failTable: null as string | null,
  inserts: [] as { table: string; row: unknown }[],
  selectAfterInsert: 0,
}));

vi.mock("../lib/supabase", () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  supabase: {
    from: (table: string) => ({
      select: () => ({
        order: async () =>
          fake.failTable === table
            ? { data: null, error: new Error("network down") }
            : { data: fake.rows[table] ?? [], error: null },
      }),
      insert: (row: unknown) => {
        fake.inserts.push({ table, row });
        return Object.assign(Promise.resolve({ error: null }), {
          select: () => {
            fake.selectAfterInsert++;
            return Promise.resolve({ data: null, error: null });
          },
        });
      },
    }),
  },
}));

// The slot step calls the booking function; its own behavior is tested in slot-step.test.tsx.
beforeEach(() => {
  sessionStorage.clear();
  installFakeBooking();
});
afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  fake.failTable = null;
  fake.inserts = [];
  fake.selectAfterInsert = 0;
  fake.rows = {
    treatments: [
      { id: "t1", slug: "prp", name: "PRP Hair Restoration", description: "", price_cents: 49500, session_count: 3 },
      { id: "t2", slug: "folix", name: "Laser Hair Restoration", description: "", price_cents: 49500, session_count: 3 },
    ],
    locations: [{ id: "l1", slug: "noho", name: "NYC Noho", address: "304 Mulberry St", timezone: "America/New_York" }],
  };
});

const url = () => screen.getByTestId("url").textContent;

describe("booking funnel", () => {
  it("lists treatments and carries the choice into the URL", async () => {
    renderAt("/book/services");
    await userEvent.click(await screen.findByRole("button", { name: /PRP Hair Restoration/ }));
    expect(url()).toBe("/book/location?service=prp");
  });

  it("carries both choices to the slot step and shows the clinic timezone", async () => {
    renderAt("/book/location?service=prp");
    await userEvent.click(await screen.findByRole("button", { name: /NYC Noho/ }));
    expect(url()).toBe("/book/slot?service=prp&location=noho");
    expect(await screen.findByText(/America\/New_York/)).toBeInTheDocument();
  });

  it("sends an unknown ?service= deep link back to the services step", async () => {
    renderAt("/book/location?service=does-not-exist");
    await waitFor(() => expect(url()).toBe("/book/services"));
  });

  it("sends the slot step back to locations when no location is chosen", async () => {
    renderAt("/book/slot?service=prp");
    await waitFor(() => expect(url()).toBe("/book/location?service=prp"));
  });

  it("sends the slot step back to services when the treatment is unknown", async () => {
    renderAt("/book/slot?service=does-not-exist&location=noho");
    await waitFor(() => expect(url()).toBe("/book/services"));
  });

  // Each test starts with a single history entry, like a visitor arriving from a
  // "Book PRP" link: browser-history back would have nowhere in the app to go.
  it.each([
    ["/book/location?service=prp", "/book/services?service=prp"],
    ["/book/slot?service=prp&location=noho", "/book/location?service=prp&location=noho"],
    ["/book/call", "/book/services"],
  ])("back from a deep link to %s goes to %s", async (start, expected) => {
    renderAt(start);
    await userEvent.click(await screen.findByRole("link", { name: "Go back" }));
    expect(url()).toBe(expected);
  });

  it("has no back button on the first step", async () => {
    renderAt("/book/services");
    await screen.findByRole("button", { name: /PRP Hair Restoration/ });
    expect(screen.queryByRole("link", { name: "Go back" })).not.toBeInTheDocument();
  });

  it("shows a retryable error when treatments fail to load", async () => {
    fake.failTable = "treatments";
    renderAt("/book/services");
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load treatments/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("free consult form", () => {
  it("validates before sending anything", async () => {
    renderAt("/book/call");
    await userEvent.click(screen.getByRole("button", { name: "Request a call" }));
    expect(screen.getByText("Enter your name")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid phone number")).toBeInTheDocument();
    expect(fake.inserts).toHaveLength(0);
  });

  it("inserts without reading the row back, and sends empty optionals as null", async () => {
    renderAt("/book/call");
    await userEvent.type(screen.getByLabelText("Full name"), "Ana Silva");
    await userEvent.type(screen.getByLabelText("Phone"), "2125550100");
    await userEvent.click(screen.getByRole("button", { name: "Request a call" }));

    expect(await screen.findByText(/we'll call you soon/)).toBeInTheDocument();
    expect(fake.inserts).toEqual([
      { table: "consult_requests", row: { full_name: "Ana Silva", phone: "2125550100", email: null, message: null } },
    ]);
    // No select grant on consult_requests: .insert().select() would fail with 42501.
    expect(fake.selectAfterInsert).toBe(0);
  });
});

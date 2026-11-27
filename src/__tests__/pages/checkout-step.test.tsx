import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeBooking } from "../helpers/fake-booking";
import { renderAt } from "../helpers/render";

// Catalog reads come from a fake supabase client; booking calls and the card tokenizer go
// to fakes behind global fetch.
vi.mock("../../lib/supabase", async () => ({
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  supabase: {
    // Signed out: the header reads the session.
    auth: (await import("../helpers/fake-auth")).fakeAuth,
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
const CHECKOUT_URL = "/book/checkout?service=prp&location=noho&date=2026-11-25";
const url = () => screen.getByTestId("url").textContent;
const calls = (action: string) => fake.state.calls.filter((c) => c.action === action);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T15:00:00Z")); // 10:00 AM in New York, the hold lapses at 10:30
  sessionStorage.clear();
  fake = installFakeBooking();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fillForm(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "First name": "Avery",
    "Last name": "Quinn",
    Email: "avery.quinn@example.com",
    "Mobile phone (optional)": "(212) 555-0123",
    "Name on card": "Avery Quinn",
    "Card number": "4242 4242 4242 4242",
    Expiry: "12/30",
    CVC: "123",
    "Billing ZIP code": "10012",
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) {
    if (value) await userEvent.type(screen.getByLabelText(label), value);
  }
}
const book = () => userEvent.click(screen.getByRole("button", { name: "Book" }));

describe("CheckoutStep", () => {
  it("shows the held time from the server, so a refresh keeps it", async () => {
    renderAt(CHECKOUT_URL);
    expect(await screen.findByRole("heading", { name: "Wed, Nov 25 at 9:00 AM" })).toBeInTheDocument();
    expect(screen.getByText("We'll keep it for 30 more minutes.")).toBeInTheDocument();
    expect(calls("summary")[0].body).toEqual({ action: "summary", sessionId: "fake|s1" });
  });

  it("sends the visitor back to pick a time when there's no live hold", async () => {
    fake.state.hold = null;
    renderAt(CHECKOUT_URL);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your hold on this time ran out");
    expect(screen.getByRole("link", { name: "Pick a time" })).toHaveAttribute("href", "/book/slot?service=prp&location=noho&date=2026-11-25");
    expect(screen.queryByRole("form", { name: "Checkout" })).not.toBeInTheDocument();
  });

  it("sends the card only to the tokenizer, and only the token to our function", async () => {
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm();
    await book();

    await waitFor(() => expect(url()).toMatch(/^\/book\/confirmed/));
    expect(fake.state.tokenizeCalls).toEqual([
      {
        url: "https://test.supabase.co/functions/v1/mock-boulevard/cards/tokenize",
        body: { card: { name: "Avery Quinn", number: "4242424242424242", cvv: "123", exp_month: 12, exp_year: 2030, address_postal_code: "10012" } },
      },
    ]);
    const [checkout] = calls("checkout");
    expect(checkout.body).toEqual({
      action: "checkout",
      sessionId: "fake|s1",
      location: "noho",
      service: "prp",
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      client: { firstName: "Avery", lastName: "Quinn", email: "avery.quinn@example.com", phone: "+12125550123" },
      cardToken: "tok-fake-1",
    });
    expect(JSON.stringify(fake.state.calls)).not.toContain("4242");
  });

  it("lands on a confirmation that shows the booked time, kept in the URL", async () => {
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm();
    await book();

    expect(await screen.findByRole("heading", { name: "Wed, Nov 25 at 9:00 AM" })).toBeInTheDocument();
    expect(screen.getByText("You're booked")).toBeInTheDocument();
    expect(url()).toBe("/book/confirmed?service=prp&location=noho&at=2026-11-25T14%3A00%3A00.000Z");
    // The booking is done: its session and key are gone, so the next booking starts clean.
    expect(sessionStorage.length).toBe(0);
  });

  it("works without a phone", async () => {
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm({ "Mobile phone (optional)": "" });
    await book();
    await waitFor(() => expect(calls("checkout")).toHaveLength(1));
    expect(calls("checkout")[0].body.client).toEqual({ firstName: "Avery", lastName: "Quinn", email: "avery.quinn@example.com" });
  });

  it("checks the form before anything leaves the browser", async () => {
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm({ Email: "not-an-email", "Mobile phone (optional)": "555", Expiry: "13/30" });
    await book();

    expect(screen.getByText("Enter a valid email")).toBeInTheDocument();
    expect(screen.getByText("Enter a phone number like (212) 555-0123")).toBeInTheDocument();
    expect(screen.getByText("Use MM/YY")).toBeInTheDocument();
    expect(fake.state.tokenizeCalls).toHaveLength(0);
    expect(calls("checkout")).toHaveLength(0);
  });

  it("masks the card fields: digits only, grouped, and no longer than the card allows", async () => {
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    const number = screen.getByLabelText("Card number");
    const expiry = screen.getByLabelText("Expiry");
    const cvc = screen.getByLabelText("CVC");

    await userEvent.type(number, "4242abc4242-4242424299");
    expect(number).toHaveValue("4242 4242 4242 4242");
    await userEvent.type(expiry, "4x3099");
    expect(expiry).toHaveValue("04/30");
    await userEvent.type(cvc, "1a2345");
    expect(cvc).toHaveValue("123");

    // An Amex has 15 digits in 4-6-5 and a 4-digit code.
    await userEvent.clear(number);
    await userEvent.type(number, "378282246310005999");
    expect(number).toHaveValue("3782 822463 10005");
    await userEvent.clear(cvc);
    await userEvent.type(cvc, "12345");
    expect(cvc).toHaveValue("1234");
  });

  it("keeps the caret in place when editing the middle of the card number", async () => {
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    const number = screen.getByLabelText("Card number") as HTMLInputElement;
    await userEvent.type(number, "42424242");
    // Put the caret after the first "42", then type a digit.
    number.setSelectionRange(2, 2);
    await userEvent.type(number, "9", { initialSelectionStart: 2, initialSelectionEnd: 2 });
    expect(number).toHaveValue("4294 2424 2"); // 42 + 9 + 424242, regrouped
    expect(number.selectionStart).toBe(3);
  });

  it("refuses a short card number, an expired card and a short code before calling anyone", async () => {
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm({ "Card number": "4242 4242", Expiry: "10/26" }); // the clock says November 2026
    await book();
    expect(screen.getByText("Enter all 16 digits")).toBeInTheDocument();
    expect(screen.getByText("This card has expired")).toBeInTheDocument();
    expect(fake.state.tokenizeCalls).toHaveLength(0);
  });

  it("asks for the 4-digit code on an Amex", async () => {
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm({ "Card number": "378282246310005", CVC: "123" });
    await book();
    expect(screen.getByText("Enter the 4-digit code")).toBeInTheDocument();
    expect(fake.state.tokenizeCalls).toHaveLength(0);
  });

  it("shows the tokenizer's refusal and doesn't call checkout", async () => {
    fake.state.cardError = "Invalid card number";
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm({ "Card number": "4242 4242 4242 4241" });
    await book();

    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't use this card: invalid card number.");
    expect(calls("checkout")).toHaveLength(0);
  });

  it("retries a brief outage with the same key, so it can't book twice", async () => {
    fake.state.next.checkout = [fake.error(503, "UNAVAILABLE")];
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm();
    await book();

    await waitFor(() => expect(url()).toMatch(/^\/book\/confirmed/), { timeout: 3000 });
    const keys = calls("checkout").map((c) => c.body.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("when the time is gone, explains it, links back, and uses a new key next time", async () => {
    fake.state.next.checkout = [fake.error(409, "SLOT_UNAVAILABLE", "Time is no longer available, please select another.")];
    renderAt(CHECKOUT_URL);
    await screen.findByRole("form", { name: "Checkout" });
    await fillForm();
    await book();

    expect(await screen.findByRole("alert")).toHaveTextContent("Time is no longer available, please select another.");
    expect(screen.getByRole("link", { name: "Pick another time" })).toHaveAttribute("href", "/book/slot?service=prp&location=noho&date=2026-11-25");

    await book(); // the form keeps what was typed
    await waitFor(() => expect(calls("checkout")).toHaveLength(2));
    const [first, second] = calls("checkout").map((c) => c.body.idempotencyKey);
    expect(second).not.toBe(first);
  });
});

import { test, expect, type Page } from "@playwright/test";
import type { Deal, DealStatus } from "../src/types";

const proof = { name: "proof.png", mimeType: "image/png", buffer: Buffer.from("test evidence") };

function makeDeal(status: DealStatus = "negotiated"): Deal {
  return {
    id: 1, product: "Silk sarees", quantity: 100,
    buyer_name: "Cape Retail", buyer_country: "South Africa",
    seller_name: "Chennai Silk House", seller_country: "India",
    deposit_percent: 30, status, ai_mode: "rule_based",
    unit_price_cents: 2200, delivery_days: 18, total_cents: 220000,
    deposit_cents: 66000, balance_cents: 154000,
    transcript: [{ party: "seller", offer_cents: 2200, message: "Agreed within both limits." }],
    buyer_approved: false, seller_approved: false,
    carrier: null, tracking_number: null, shipped_quantity: null,
    verification: null, tracking_added: false,
    received_quantity: null, damaged_quantity: null, inspection_notes: null,
    claim: null, refund_suggested_cents: null, refund_id: null, refund_status: null,
    payments: [], evidence: [],
    reference: "TC-TEST2345", created_at: "2026-11-07T08:00:00",
    buyer_deadline_days: 21, delay_days: 0, delivered: true, watcher: null, events: [],
    activity: [],
  };
}

// API responses are controlled here: these tests exercise the real frontend,
// without creating deals, uploading files, or moving money on external services.
async function mockApi(page: Page, status: DealStatus = "negotiated") {
  const state = {
    deal: makeDeal(status), empty: false, failList: false, failLoad: false,
    failCapture: false, pendingCapture: false, rejectProof: false,
    creationError: false, createCount: 0, captureCount: 0, shipmentCount: 0,
    inspectionCount: 0, creation: {} as Record<string, unknown>, inspection: "",
    trackingUpdates: [] as Array<Record<string, unknown>>,
  };
  await page.route(/\/api\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const method = request.method();
    const respond = (json: unknown, status = 200) => route.fulfill({
      status, json, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" },
    });
    if (method === "OPTIONS") return respond({});
    if (path === "/suppliers") return respond([{
      seller_name: "Chennai Silk House", seller_country: "India", product: "Silk sarees", seller_min_cents: 2000, seller_lead_days: 18,
    }]);
    if (path === "/deals" && method === "GET") {
      return state.failList ? respond({ detail: "Service temporarily unavailable." }, 503) : respond(state.empty ? [] : [state.deal]);
    }
    if (path === "/deals" && method === "POST") {
      state.createCount++;
      state.creation = request.postDataJSON();
      if (state.creationError) return respond({ detail: [{ loc: ["body", "quantity"], msg: "Quantity is not available." }] }, 422);
      return respond(state.deal, 201);
    }
    if (path === "/deals/1" && method === "GET") {
      return state.failLoad ? respond({ detail: "Deal not found." }, 404) : respond(state.deal);
    }
    if (path === "/deals/1/approve") {
      const { party } = request.postDataJSON() as { party: "buyer" | "seller" };
      state.deal[party === "buyer" ? "buyer_approved" : "seller_approved"] = true;
      if (state.deal.buyer_approved && state.deal.seller_approved) state.deal.status = "approved";
      return respond(state.deal);
    }
    const payment = path.match(/^\/deals\/1\/payments\/(deposit|balance)(\/capture)?$/);
    if (payment) {
      const kind = payment[1] as "deposit" | "balance";
      if (!payment[2]) return respond({ approval_url: `https://paypal.test/checkout?kind=${kind}` });
      state.captureCount++;
      if (state.failCapture) return respond({ detail: "PayPal couldn't complete this payment." }, 502);
      state.deal.payments = state.deal.payments.filter((item) => item.kind !== kind);
      state.deal.payments.push({ kind, amount_cents: kind === "deposit" ? 66000 : 154000, order_id: kind, capture_id: kind, status: state.pendingCapture ? "PENDING" : "COMPLETED" });
      if (!state.pendingCapture) state.deal.status = kind === "deposit" ? "deposit_paid" : "balance_paid";
      return respond(state.deal);
    }
    if (path === "/deals/1/shipment") {
      state.shipmentCount++;
      state.deal.status = state.rejectProof ? "proof_review" : "shipment_verified";
      state.deal.verification = { matches: !state.rejectProof, summary: state.rejectProof ? "Proof needs review." : "Shipment matches the order.", issues: state.rejectProof ? ["Quantity mismatch"] : [], mode: "rule_based" };
      return respond(state.deal);
    }
    if (path === "/deals/1/shipment/accept") {
      state.deal.status = "shipment_verified";
      return respond(state.deal);
    }
    if (path === "/deals/1/inspection") {
      state.inspectionCount++;
      state.inspection = request.postData() || "";
      const received = state.inspection.match(/name="received_quantity"\r\n\r\n(\d+)/)?.[1];
      const damaged = state.inspection.match(/name="damaged_quantity"\r\n\r\n(\d+)/)?.[1];
      state.deal.status = Number(received) >= 100 && Number(damaged) === 0 ? "closed" : "refund_suggested";
      state.deal.claim = { reasoning: "Refund for affected goods.", mode: "rule_based" };
      state.deal.refund_suggested_cents = 22000;
      return respond(state.deal);
    }
    if (path === "/deals/1/claim/approve") {
      state.deal.status = "refunded";
      state.deal.refund_id = "refund-1";
      state.deal.refund_status = "COMPLETED";
      return respond(state.deal);
    }
    if (path === "/deals/1/tracking/updates") {
      const update = request.postDataJSON() as { kind: "milestone" | "delay"; delay_days?: number; note?: string };
      state.trackingUpdates.push(update);
      const events = state.deal.events;
      const last = events.filter((event) => event.kind === "update").at(-1)?.stage ?? 0;
      if (update.kind === "delay") {
        state.deal.delay_days += update.delay_days ?? 0;
        events.push({ stage: last, kind: "delay", title: `Delayed by ${update.delay_days} days`, location: "Port of departure, India", day: 1, note: update.note || null });
      } else {
        const stage = last + 1;
        events.push({ stage, kind: "update", title: stage === 6 ? "Delivered" : `Milestone ${stage}`, location: "Route", day: stage * 3, note: update.note || null });
        state.deal.delivered = stage === 6;
      }
      const delivered = state.deal.delivered;
      state.deal.watcher = {
        level: delivered ? "delivered" : state.deal.delay_days ? "late" : "on_track",
        agreed_day: 18, projected_day: 18 + state.deal.delay_days, deadline_day: 21, delay_days: state.deal.delay_days,
        missed_deadline: 18 + state.deal.delay_days > 21,
        summary: delivered ? "The shipment has been delivered." : "Watcher summary.",
        buyer_message: "Buyer note.", seller_message: "Seller note.", action: "Keep watching.", mode: "rule_based",
        next_milestone: delivered ? null : "Next stop",
      };
      return respond(state.deal);
    }
    if (path === "/deals/1/claim/reject") {
      state.deal.status = "claim_rejected";
      return respond(state.deal);
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  await page.route("https://paypal.test/**", async (route) => {
    const kind = new URL(route.request().url()).searchParams.get("kind");
    await route.fulfill({ contentType: "text/html", body: `<a href="http://127.0.0.1:3100/deals/1?paypal=return&kind=${kind}">Approve sandbox payment</a><a href="http://127.0.0.1:3100/deals/1?paypal=cancel">Cancel payment</a>` });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as Page & { runtimeErrors: string[] }).runtimeErrors = errors;
});

test.afterEach(async ({ page }) => {
  expect((page as Page & { runtimeErrors: string[] }).runtimeErrors).toEqual([]);
  if (new URL(page.url()).hostname === "127.0.0.1") {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("home, navbar, dashboard, new deal and deal links work", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cross-border trade you can trust");
  await page.getByRole("link", { name: "Start a deal" }).click();
  await expect(page).toHaveURL(/\/deals\/new$/);
  await page.getByRole("navigation").getByRole("link", { name: "Dashboard" }).click();
  await page.getByRole("link").filter({ hasText: "Silk sarees" }).click();
  await expect(page.getByRole("heading", { name: "Both people must approve" })).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "New deal" }).click();
  await expect(page.getByRole("heading", { name: "Start a deal" })).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "TrustCargo" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.locator("a button")).toHaveCount(0);
  await page.getByRole("navigation").getByRole("link", { name: "TrustCargo" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Dashboard" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("dashboard empty state and load retry work", async ({ page }) => {
  const state = await mockApi(page);
  state.failList = true;
  await page.goto("/dashboard");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Service temporarily unavailable");
  state.failList = false;
  state.empty = true;
  await page.getByRole("button", { name: "Retry loading deals" }).click();
  await expect(page.getByText("No deals yet.")).toBeVisible();
  await page.getByRole("link", { name: "Start a deal" }).click();
  await expect(page).toHaveURL(/\/deals\/new$/);
});

test("deal form blocks invalid values and preserves valid negotiation limits", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/deals/new");
  const quantity = page.getByLabel("Quantity", { exact: true });
  for (const value of ["1.5", "0", "100001"]) {
    await quantity.fill(value);
    await page.getByRole("button", { name: "Start AI negotiation" }).click();
    expect(state.createCount).toBe(0);
  }
  await quantity.fill("100");
  const days = page.getByLabel("Needed within (days)");
  for (const value of ["1.5", "366"]) {
    await days.fill(value);
    await page.getByRole("button", { name: "Start AI negotiation" }).click();
    expect(state.createCount).toBe(0);
  }
  await days.fill("21");
  await page.getByLabel("Product", { exact: true }).fill("   ");
  await page.getByRole("button", { name: "Start AI negotiation" }).click();
  expect(state.createCount).toBe(0);
  await page.getByLabel("Product", { exact: true }).fill(" Silk sarees ");
  await page.getByLabel("Maximum price per unit (USD)").fill("10.25");
  await page.getByRole("button", { name: "Start AI negotiation" }).click();
  await expect(page).toHaveURL(/\/deals\/1$/);
  expect(state.creation).toMatchObject({ quantity: 100, product: "Silk sarees", buyer_max_cents: 1025, seller_min_cents: 2000 });
});

test("structured API validation is shown and the form can be retried", async ({ page }) => {
  const state = await mockApi(page);
  state.creationError = true;
  await page.goto("/deals/new");
  await page.getByRole("button", { name: "Start AI negotiation" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("quantity: Quantity is not available.");
  state.creationError = false;
  await page.getByRole("button", { name: "Start AI negotiation" }).click();
  await expect(page).toHaveURL(/\/deals\/1$/);
});

async function pay(page: Page, kind: "deposit" | "balance") {
  await page.getByRole("button", { name: kind === "deposit" ? "Pay with PayPal" : /Pay .* with PayPal/ }).click();
  await expect(page).toHaveURL(/paypal\.test/);
  await page.getByRole("link", { name: "Approve sandbox payment" }).click();
  await expect(page.getByRole("heading", { name: kind === "deposit" ? "Seller: upload shipping proof" : "Buyer: inspect the goods" })).toBeVisible();
}

test("complete deal flow from creation through approvals and both payments to closure", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/deals/new");
  await page.getByRole("button", { name: "Start AI negotiation" }).click();
  await page.getByRole("button", { name: "Approve as buyer" }).click();
  await expect(page.getByRole("button", { name: "Buyer approved" })).toBeDisabled();
  await page.getByRole("button", { name: "Approve as seller" }).click();
  await expect(page.getByRole("heading", { name: "Buyer: pay the deposit" })).toBeVisible();
  await pay(page, "deposit");
  await page.getByLabel("Tracking number").fill("1234567890");
  await page.getByLabel(/Shipping proof/).setInputFiles(proof);
  await page.getByRole("button", { name: "Submit for AI check" }).click();
  await expect(page.getByRole("heading", { name: "Buyer: pay the balance" })).toBeVisible();
  await pay(page, "balance");
  await page.getByRole("button", { name: "Submit inspection" }).click();
  await expect(page.getByRole("heading", { name: "Order closed" })).toBeVisible();
  expect(state.captureCount).toBe(2);
  expect(state.inspection).not.toContain('filename=""');
});

test("PayPal cancellation stays visible and checkout can be restarted", async ({ page }) => {
  await mockApi(page, "approved");
  await page.goto("/deals/1");
  await page.getByRole("button", { name: "Pay with PayPal" }).click();
  await page.getByRole("link", { name: "Cancel payment" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("payment was cancelled");
  await expect(page).toHaveURL(/\/deals\/1$/);
  await pay(page, "deposit");
});

test("failed payment capture retains the return link and supports retry", async ({ page }) => {
  const state = await mockApi(page, "approved");
  state.failCapture = true;
  await page.goto("/deals/1?paypal=return&kind=deposit");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("PayPal couldn't complete");
  await expect(page).toHaveURL(/paypal=return/);
  state.failCapture = false;
  await page.getByRole("button", { name: "Retry payment confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Seller: upload shipping proof" })).toBeVisible();
  await expect(page).toHaveURL(/\/deals\/1$/);
  expect(state.captureCount).toBe(2);
});

test("pending payment blocks a second checkout until confirmation completes", async ({ page }) => {
  const state = await mockApi(page, "approved");
  state.pendingCapture = true;
  await page.goto("/deals/1?paypal=return&kind=deposit");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("still processing");
  await expect(page.getByRole("button", { name: "Pay with PayPal" })).toBeDisabled();
  state.pendingCapture = false;
  await page.getByRole("button", { name: "Retry payment confirmation" }).click();
  await expect(page.getByRole("heading", { name: "Seller: upload shipping proof" })).toBeVisible();
});

test("deal loading can be retried and malformed return kinds are not captured", async ({ page }) => {
  const state = await mockApi(page);
  state.failLoad = true;
  await page.goto("/deals/1?paypal=return&kind=invalid");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Deal not found");
  state.failLoad = false;
  await page.getByRole("button", { name: "Retry loading deal" }).click();
  await expect(page.getByRole("heading", { name: "Both people must approve" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("return link is invalid");
  expect(state.captureCount).toBe(0);
});

test("shipping rejects excessive, oversized, empty and unsupported files before submitting", async ({ page }) => {
  const state = await mockApi(page, "deposit_paid");
  await page.goto("/deals/1");
  await page.getByLabel("Tracking number").fill("1234567890");
  const files = page.getByLabel(/Shipping proof/);
  for (const [uploads, message] of [
    [Array.from({ length: 4 }, (_, i) => ({ ...proof, name: `${i}.png` })), "up to 3 files"],
    [[{ ...proof, buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }], "5 MB or less"],
    [[{ ...proof, buffer: Buffer.alloc(0) }], "file is empty"],
    [[{ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("bad") }], "choose a JPG"],
  ] as const) {
    await files.setInputFiles([...uploads]);
    await page.getByRole("button", { name: "Submit for AI check" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(message);
    expect(state.shipmentCount).toBe(0);
  }
  await files.setInputFiles(proof);
  await page.getByRole("button", { name: "Submit for AI check" }).click();
  await expect(page.getByRole("heading", { name: "Buyer: pay the balance" })).toBeVisible();
});

for (const accept of [true, false]) {
  test(`rejected shipping proof can be ${accept ? "accepted by buyer" : "resubmitted"}`, async ({ page }) => {
    const state = await mockApi(page, "deposit_paid");
    state.rejectProof = true;
    await page.goto("/deals/1");
    await page.getByLabel("Tracking number").fill("1234567890");
    await page.getByLabel(/Shipping proof/).setInputFiles(proof);
    await page.getByRole("button", { name: "Submit for AI check" }).click();
    await expect(page.getByText("Quantity mismatch")).toBeVisible();
    if (accept) await page.getByRole("button", { name: "Buyer: accept this proof anyway" }).click();
    else {
      state.rejectProof = false;
      await page.getByRole("button", { name: "Submit for AI check" }).click();
    }
    await expect(page.getByRole("heading", { name: "Buyer: pay the balance" })).toBeVisible();
  });
}

for (const approve of [true, false]) {
  test(`inspection validates counts and optional uploads, then refund can be ${approve ? "approved" : "rejected"}`, async ({ page }) => {
    const state = await mockApi(page, "balance_paid");
    await page.goto("/deals/1");
    await page.getByLabel("Quantity received").fill("5");
    await page.getByLabel("Quantity damaged").fill("6");
    await page.getByRole("button", { name: "Submit inspection" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("cannot exceed received");
    expect(state.inspectionCount).toBe(0);
    await page.getByLabel("Quantity damaged").fill("1");
    await page.getByLabel(/Delivery photos/).setInputFiles(Array.from({ length: 4 }, (_, i) => ({ ...proof, name: `${i}.png` })));
    await page.getByRole("button", { name: "Submit inspection" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("up to 3 files");
    expect(state.inspectionCount).toBe(0);
    await page.getByLabel(/Delivery photos/).setInputFiles([]);
    await page.getByRole("button", { name: "Submit inspection" }).click();
    await expect(page.getByRole("heading", { name: "Seller: review the suggested refund" })).toBeVisible();
    await page.getByRole("button", { name: approve ? "Approve refund" : "Reject", exact: true }).click();
    await expect(page.getByRole("heading", { name: approve ? "Refund sent" : "Claim rejected" })).toBeVisible();
  });
}

test("failed negotiation offers a working path to new limits", async ({ page }) => {
  await mockApi(page, "no_deal");
  await page.goto("/deals/1");
  await expect(page.getByRole("heading", { name: "No deal", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Try new limits" }).click();
  await expect(page.getByRole("heading", { name: "Start a deal" })).toBeVisible();
});

test("dashboard refresh picks up deals created elsewhere and status changes", async ({ page }) => {
  const state = await mockApi(page);
  state.empty = true;
  await page.goto("/dashboard");
  await expect(page.getByText("No deals yet.")).toBeVisible();
  state.empty = false;
  state.deal.status = "approved";
  await page.getByRole("button", { name: "Refresh deals" }).click();
  await expect(page.getByText("Deposit due", { exact: true })).toBeVisible();
  state.deal.status = "deposit_paid";
  await page.getByRole("button", { name: "Refresh deals" }).click();
  await expect(page.getByText("Waiting for shipment", { exact: true })).toBeVisible();
});

test("deal refresh picks up the other party's approval without submitting actions", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/deals/1");
  await expect(page.getByRole("heading", { name: "Both people must approve" })).toBeVisible();
  state.deal.buyer_approved = true;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("button", { name: "Buyer approved" })).toBeDisabled();
  state.deal.seller_approved = true;
  state.deal.status = "approved";
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("heading", { name: "Buyer: pay the deposit" })).toBeVisible();
  expect(state.captureCount).toBe(0);
  expect(state.createCount).toBe(0);
});

test("refresh preserves shipping inputs and recovers from a failed refresh", async ({ page }) => {
  const state = await mockApi(page, "deposit_paid");
  await page.goto("/deals/1");
  await page.getByLabel("Tracking number").fill("DHL-DRAFT-123");
  await page.getByRole("combobox", { name: "Carrier", exact: true }).selectOption("UPS");
  await page.getByLabel(/Shipping proof/).setInputFiles(proof);
  state.failLoad = true;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Deal not found");
  await expect(page.getByLabel("Tracking number")).toHaveValue("DHL-DRAFT-123");
  state.failLoad = false;
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Tracking number")).toHaveValue("DHL-DRAFT-123");
  await expect(page.getByRole("combobox", { name: "Carrier", exact: true })).toHaveValue("UPS");
  expect(await page.getByLabel(/Shipping proof/).evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe("proof.png");
  expect(state.shipmentCount).toBe(0);
});

test("pending refunds are not shown as completed and can be refreshed", async ({ page }) => {
  const state = await mockApi(page, "refunded");
  state.deal.refund_status = "PENDING";
  state.deal.refund_id = "refund-1";
  state.deal.refund_suggested_cents = 22000;
  await page.goto("/dashboard");
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  await page.getByRole("link").filter({ hasText: "Silk sarees" }).click();
  await expect(page.getByRole("heading", { name: "Refund status", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Refund sent", exact: true })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Deal progress" }).locator('[aria-current="step"]')).toContainText("Inspect");
  state.deal.refund_status = "COMPLETED";
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("heading", { name: "Refund sent", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByText("Refund pending", { exact: true })).toHaveCount(0);
  expect(state.captureCount).toBe(0);
});

test("original teal styling works across pages and system color preferences", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  let dashboardBounds: { x: number; width: number } | undefined;
  for (const [name, route] of [["home", "/"], ["dashboard", "/dashboard"], ["new-deal", "/deals/new"], ["deal-room", "/deals/1"]]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (name === "dashboard") await expect(page.getByRole("button", { name: "Refresh deals" })).toBeVisible();
    if (name === "new-deal") await expect(page.getByRole("combobox", { name: "Sample supplier" })).toBeVisible();
    if (name === "deal-room") await expect(page.getByRole("button", { name: "Approve as buyer" })).toBeVisible();
    if (name === "dashboard" || name === "new-deal") {
      const bounds = await page.locator("main").boundingBox();
      expect(bounds).not.toBeNull();
      if (name === "dashboard") dashboardBounds = bounds!;
      else {
        expect(bounds!.x).toBeCloseTo(dashboardBounds!.x, 0);
        expect(bounds!.width).toBeCloseTo(dashboardBounds!.width, 0);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const path = testInfo.outputPath(`${name}-light.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`${name}-light`, { path, contentType: "image/png" });
  }
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("#background-particles")).toHaveCount(0);
  await expect(page.getByText("Example route", { exact: false })).toHaveCount(0);
  await expect(page.getByText("India", { exact: true })).toHaveCount(0);
  await expect(page.getByText("South Africa", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(16, 31, 37)");
  await page.screenshot({ path: testInfo.outputPath("home-system-dark.png"), fullPage: true });
  await page.goto("/deals/1");
  await page.getByRole("button", { name: "Approve as buyer" }).click();
  await expect(page.getByRole("button", { name: "Buyer approved" })).toBeDisabled();
  await expect(page.getByRole("list", { name: "Deal progress" }).locator('[aria-current="step"]')).toContainText("Approve");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(16, 31, 37)");
  await page.screenshot({ path: testInfo.outputPath("deal-room-system-dark.png"), fullPage: true });
});


test("carrier updates move the shipment to delivery before inspection", async ({ page }) => {
  const state = await mockApi(page, "balance_paid");
  state.deal.delivered = false;
  state.deal.carrier = "DHL";
  state.deal.tracking_number = "1234567890";
  state.deal.events = [{ stage: 0, kind: "update", title: "Picked up by carrier", location: "India, seller warehouse", day: 0, note: null }];
  state.deal.watcher = {
    level: "on_track", agreed_day: 18, projected_day: 18, deadline_day: 21, delay_days: 0, missed_deadline: false,
    summary: "The shipment is on schedule.", buyer_message: "On time.", seller_message: "On time.", action: "No action needed.",
    mode: "rule_based", next_milestone: "Departed origin port",
  };
  state.deal.evidence = [{ id: 7, stage: "shipment", original_name: "receipt.pdf", content_type: "application/pdf", size_bytes: 2048, url: "/api/deals/1/evidence/7" }];
  state.deal.activity = [{ actor: "seller", message: "Submitted 1 proof file(s).", created_at: "2026-11-07T08:00:00" }];
  await page.goto("/deals/1");

  await expect(page.getByRole("heading", { name: "Waiting for delivery" })).toBeVisible();
  await expect(page.getByText("In transit", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Shipping proof: receipt.pdf" })).toHaveAttribute("href", /\/api\/deals\/1\/evidence\/7$/);
  await expect(page.getByText("Submitted 1 proof file(s).")).toBeVisible();
  await expect(page.getByText("Deal TC-TEST2345")).toBeVisible();

  await page.getByLabel("Note (optional)").fill("Held for customs paperwork");
  await page.getByLabel("Delay (days)").fill("4");
  await page.getByRole("button", { name: "Report delay" }).click();
  await expect(page.getByText("Note: Held for customs paperwork")).toBeVisible();
  expect(state.trackingUpdates[0]).toEqual({ kind: "delay", delay_days: 4, note: "Held for customs paperwork" });

  for (let index = 0; index < 6; index++) {
    await page.getByRole("button", { name: /^Record:/ }).click();
    await expect(page.getByText(`Day ${(index + 1) * 3}:`)).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Buyer: inspect the goods" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Record:/ })).toHaveCount(0);
  expect(state.trackingUpdates).toHaveLength(7);
});

test("guide explains the steps and answers common questions", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("link", { name: "How it works" }).click();
  await expect(page).toHaveURL(/\/guide$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("How TrustCargo works");

  const steps = page.getByRole("list", { name: "Deal steps" });
  await expect(steps.getByRole("button")).toHaveCount(8);
  await steps.getByRole("button", { name: /Track/ }).click();
  await expect(page.getByRole("heading", { name: "Track", level: 3 })).toBeVisible();
  await expect(page.getByText("A ship moves along the route.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(page.getByRole("heading", { name: "Inspect", level: 3 })).toBeVisible();

  const question = page.getByRole("button", { name: "Is this real money?" });
  await question.click();
  await expect(question).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Payments run in the PayPal sandbox", { exact: false })).toBeVisible();

  await page.getByRole("link", { name: "Start your first deal" }).click();
  await expect(page).toHaveURL(/\/deals\/new$/);
});

test("bills reached so far can be downloaded", async ({ page }) => {
  const state = await mockApi(page, "approved");
  state.deal.documents = [
    { kind: "agreement", title: "Trade agreement", url: "/api/deals/1/documents/agreement.pdf" },
    { kind: "deposit", title: "Deposit invoice", url: "/api/deals/1/documents/deposit.pdf" },
  ];
  await page.goto("/deals/1");

  const bar = page.getByRole("region", { name: "Documents" });
  await expect(bar.getByRole("link")).toHaveCount(2);
  await expect(bar.getByRole("link", { name: /Trade agreement/ })).toHaveAttribute("href", /\/api\/deals\/1\/documents\/agreement\.pdf$/);
  await expect(bar.getByRole("link", { name: /Deposit invoice/ })).toHaveAttribute("download", "");
  await expect(page.getByRole("link", { name: "Download deposit invoice" })).toBeVisible();
});

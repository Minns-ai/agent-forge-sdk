import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { captureSnapshot } from "../../src/browser/snapshot.js";
import { chromiumPath, launch, site } from "./helpers.js";

const hasBrowser = !!(await chromiumPath());

describe.skipIf(!hasBrowser)("captureSnapshot", { timeout: 30_000 }, () => {
  let browser: Browser;
  let web: Awaited<ReturnType<typeof site>>;

  beforeAll(async () => {
    browser = await launch();
    web = await site({
      "/": (u) => `<!doctype html><title>Shop</title>
        <h1>Checkout</h1>
        <form action="/done">
          <label>Email <input name="email" value="a@b.co"></label>
          <label>Password <input type="password" name="pw" value="hunter2"></label>
          <button data-testid="pay">Pay now</button>
        </form>
        <a href="/help">Help</a>
        <div id="host"></div>
        <iframe srcdoc="<button>Same site</button>"></iframe>
        <iframe src="${u.searchParams.get("other")}/inner"></iframe>
        <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML = '<button>In shadow</button>';</script>`,
      "/inner": `<!doctype html><button name="card">Card button</button>`,
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await web?.close();
  });

  it("reads every frame and shadow root into one outline with ids", async () => {
    const page = await browser.newPage();
    await page.goto(`${web.base}/?other=${encodeURIComponent(web.other)}`);
    await page.waitForLoadState("networkidle");
    const snap = await captureSnapshot(page);
    const byName = (n: string) => Object.values(snap.elements).find((e) => e.name === n);

    expect(snap.title).toBe("Shop");
    expect(snap.outline).toMatch(/\[0-\d+\] heading: Checkout/);
    expect(snap.outline).toMatch(/\[0-\d+\] button: In shadow/);
    expect(snap.outline).toMatch(/\[\d+-\d+\] button: Same site/);
    expect(snap.outline).toMatch(/\[\d+-\d+\] button: Card button/);
    expect(snap.outline).toMatch(/link: Help -> http:\/\/127\.0\.0\.1:\d+\/help/);

    const pay = byName("Pay now")!;
    expect(pay.submits).toBe(true);
    expect(pay.target.fp).toMatchObject({ tag: "button", role: "button", testid: "pay" });
    expect(pay.target.frames).toEqual([]);

    const shadow = byName("In shadow")!;
    expect(shadow.target.xpath).toContain("//");

    const card = byName("Card button")!;
    expect(card.target.frames).toHaveLength(1);
    expect(card.target.frames[0].origin).toMatch(/^localhost:/);
    expect(card.target.fp.frame).toMatch(/^localhost:/);
    expect(card.target.fp.name).toBe("card");

    const same = byName("Same site")!;
    expect(same.target.frames[0].origin).toMatch(/\(embedded\)$/);

    const email = Object.values(snap.elements).find((e) => e.target.fp.name === "email")!;
    expect(email.enterSubmits).toBe(true);
    expect(email.value).toBe("a@b.co");
    expect(snap.outline).not.toContain("hunter2");
    await page.close();
  });

  it("hides a value the caller says is secret, and cuts a long outline", async () => {
    const page = await browser.newPage();
    await page.goto(`${web.base}/?other=${encodeURIComponent(web.other)}`);
    const snap = await captureSnapshot(page, { hideValue: (v) => v === "a@b.co", maxChars: 120 });
    expect(snap.outline).not.toContain("a@b.co");
    expect(snap.truncated).toBe(true);
    expect(snap.outline).toContain("the outline was cut");
    // Every element is still known, past the cut, so a target can be found.
    expect(Object.values(snap.elements).some((e) => e.name === "Card button")).toBe(true);
    await page.close();
  });
});

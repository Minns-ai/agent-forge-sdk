import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import { PageDriver } from "../../src/browser/page-driver.js";
import { chromiumPath, launch, site } from "./helpers.js";

const hasBrowser = !!(await chromiumPath());

const idOf = (outline: string, line: RegExp): string => {
  const m = outline.split("\n").find((l) => line.test(l))?.match(/\[(\d+-\d+)\]/);
  if (!m) throw new Error(`no line like ${line} in\n${outline}`);
  return m[1];
};

describe.skipIf(!hasBrowser)("PageDriver", { timeout: 30_000 }, () => {
  let browser: Browser;
  let web: Awaited<ReturnType<typeof site>>;

  beforeAll(async () => {
    browser = await launch();
    web = await site({
      "/form": `<!doctype html><title>Form</title>
        <form action="/done" method="get">
          <label>Email <input name="email"></label>
          <label>Password <input type="password" name="pw"></label>
          <select name="plan"><option>Basic</option><option>Pro</option></select>
          <label><input type="checkbox" name="news"> News</label>
          <button>Send it</button>
        </form>`,
      "/done": (u) => `<!doctype html><title>Done</title><p>Thanks ${u.searchParams.get("email")} on ${u.searchParams.get("plan")}</p>`,
      "/frames": (u) => `<!doctype html><title>Frames</title><p id="out">none</p><div id="host"></div>
        <iframe src="${u.searchParams.get("other")}/inner"></iframe>
        <script>
          const r = document.getElementById('host').attachShadow({mode:'open'});
          r.innerHTML = '<button>Shadow press</button>';
          r.querySelector('button').onclick = () => document.getElementById('out').textContent = 'shadow';
        </script>`,
      "/inner": `<!doctype html><p id="o">idle</p><button onclick="document.getElementById('o').textContent='pressed inside'">Inner press</button>`,
      "/moving": `<!doctype html><title>Moving</title><div id="list"><button>Alpha</button><button data-testid="go">Go</button></div>
        <p id="said">quiet</p>
        <script>
          document.querySelector('[data-testid=go]').onclick = () => document.getElementById('said').textContent = 'went';
          window.rebuild = () => { const l = document.getElementById('list'); const w = document.createElement('section'); w.appendChild(l); document.body.prepend(w); const g = l.querySelector('[data-testid=go]'); l.prepend(g); };
        </script>`,
      "/dialog": `<!doctype html><title>Dialog</title><p id="r">-</p><button onclick="document.getElementById('r').textContent = confirm('Sure?') ? 'yes' : 'no'">Ask me</button>`,
      "/file": `<!doctype html><title>File</title><a href="/report.csv" download>Get the report</a><a href="/done?email=x&plan=y" target="_blank">Open elsewhere</a>`,
      "/report.csv": "a,b\n1,2\n",
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await web?.close();
  });

  it("fills a form, and refuses to submit it until allowed", async () => {
    const page = await browser.newPage();
    const d = new PageDriver(page);
    expect((await d.perform({ method: "goto", args: [`${web.base}/form`] })).ok).toBe(true);
    let view = await d.look();
    expect((await d.perform({ method: "fill", id: idOf(view.outline, /textbox: Email/), args: ["me@x.co"] })).ok).toBe(true);
    expect((await d.perform({ method: "selectOption", id: idOf(view.outline, /select/), args: ["Pro"] })).ok).toBe(true);
    expect((await d.perform({ method: "check", id: idOf(view.outline, /checkbox: News/) })).ok).toBe(true);
    const send = idOf(view.outline, /button: Send it/);

    const refused = await d.perform({ method: "click", id: send });
    expect(refused).toMatchObject({ ok: false, reason: "submits", label: "Send it" });
    const enter = await d.perform({ method: "press", id: idOf(view.outline, /textbox: Email/), args: ["Enter"] });
    expect(enter).toMatchObject({ ok: false, reason: "submits" });
    const newline = await d.perform({ method: "fill", id: idOf(view.outline, /textbox: Email/), args: ["a\nb"] });
    expect(newline).toMatchObject({ ok: false, reason: "refused" });

    const sent = await d.perform({ method: "click", id: send, allowSubmit: true });
    expect(sent).toMatchObject({ ok: true, title: "Done", found: "same" });
    view = await d.look();
    expect(view.outline).toContain("Thanks me@x.co on Pro");
    await page.close();
  });

  it("shows an approver the form, and presses only if nothing changed since", async () => {
    const page = await browser.newPage();
    const d = new PageDriver(page);
    await d.perform({ method: "goto", args: [`${web.base}/form`] });
    let view = await d.look();
    await d.perform({ method: "fill", id: idOf(view.outline, /textbox: Email/), args: ["me@x.co"] });
    await d.perform({ method: "fill", id: idOf(view.outline, /textbox: Password/), args: ["pw"] });
    const send = idOf(view.outline, /button: Send it/);
    const seen = await d.inspect({ id: send });
    if ("error" in seen) throw new Error(seen.error);
    expect(seen).toMatchObject({ label: "Send it", enterSubmits: false });
    expect(seen.fields).toMatchObject({ Email: "me@x.co", Password: "(hidden)", News: "unchecked" });
    expect(seen.image).toMatch(/^data:image\/jpeg;base64,/);

    // The agent changes the email after the person approved.
    await d.perform({ method: "fill", id: idOf(view.outline, /textbox: Email/), args: ["other@x.co"] });
    const stale = await d.perform({ method: "click", target: seen.target, allowSubmit: true, expect: { url: seen.url, fields: seen.fields } });
    expect(stale).toMatchObject({ ok: false, reason: "lost" });
    expect((stale as { error: string }).error).toContain('"Email" changed');

    await d.perform({ method: "fill", id: idOf(view.outline, /textbox: Email/), args: ["me@x.co"] });
    const sent = await d.perform({ method: "click", target: seen.target, allowSubmit: true, expect: { url: seen.url, fields: seen.fields } });
    expect(sent).toMatchObject({ ok: true, title: "Done", submitted: true });

    // Approved on one page, and the browser is elsewhere now.
    const away = await d.perform({ method: "click", target: seen.target, allowSubmit: true, expect: { url: seen.url } });
    expect(away).toMatchObject({ ok: false });
    view = await d.look();
    await page.close();
  });

  it("uploads only what the host allows", async () => {
    const page = await browser.newPage();
    await page.setContent('<input type="file" aria-label="Attach"><p id="n"></p><script>document.querySelector("input").onchange = (e) => document.getElementById("n").textContent = e.target.files[0].name</script>');
    const none = new PageDriver(page);
    let view = await none.look();
    expect(await none.perform({ method: "upload", id: idOf(view.outline, /Attach/), args: ["x.txt"] })).toMatchObject({ ok: false, reason: "refused" });
    const dir = mkdtempSync(path.join(tmpdir(), "up-"));
    const file = path.join(dir, "notes.txt");
    (await import("node:fs")).writeFileSync(file, "hi");
    const d = new PageDriver(page, { resolveUpload: (p) => { if (p !== "notes.txt") throw new Error("upload takes a file inside the workspace"); return file; } });
    view = await d.look();
    expect(await d.perform({ method: "upload", id: idOf(view.outline, /Attach/), args: ["../etc/passwd"] })).toMatchObject({ ok: false, reason: "refused", error: "upload takes a file inside the workspace" });
    expect((await d.perform({ method: "upload", id: idOf(view.outline, /Attach/), args: ["notes.txt"] })).ok).toBe(true);
    expect((await d.look()).outline).toContain("notes.txt");
    await page.close();
  });

  it("presses inside a cross-site iframe and a shadow root", async () => {
    const page = await browser.newPage();
    const d = new PageDriver(page);
    await d.perform({ method: "goto", args: [`${web.base}/frames?other=${encodeURIComponent(web.other)}`] });
    let view = await d.look();
    expect((await d.perform({ method: "click", id: idOf(view.outline, /button: Inner press/) })).ok).toBe(true);
    expect((await d.perform({ method: "click", id: idOf(view.outline, /button: Shadow press/) })).ok).toBe(true);
    view = await d.look();
    expect(view.outline).toContain("pressed inside");
    expect(view.outline).toContain("StaticText: shadow");
    await page.close();
  });

  it("finds a recorded button after the page is rebuilt, and says lost when it is gone", async () => {
    const page = await browser.newPage();
    const d = new PageDriver(page);
    await d.perform({ method: "goto", args: [`${web.base}/moving`] });
    const view = await d.look();
    const first = await d.perform({ method: "scrollIntoView", id: idOf(view.outline, /button: Go/) });
    expect(first.ok).toBe(true);
    const target = first.ok ? first.target! : undefined;

    await page.evaluate("rebuild()");
    const again = await d.perform({ method: "click", target });
    expect(again).toMatchObject({ ok: true, found: "moved" });
    expect((await d.look()).outline).toContain("went");

    await page.evaluate("document.querySelector('[data-testid=go]').remove()");
    const lost = await d.perform({ method: "click", target });
    expect(lost).toMatchObject({ ok: false, reason: "lost" });
    await page.close();
  });

  it("does not click a different control that took the recorded one's place", async () => {
    const page = await browser.newPage();
    const d = new PageDriver(page);
    await d.perform({ method: "goto", args: [`${web.base}/moving`] });
    const view = await d.look();
    const r = await d.perform({ method: "hover", id: idOf(view.outline, /button: Alpha/) });
    const target = r.ok ? r.target! : undefined;
    // Same position, another button: Alpha renamed to Beta.
    await page.evaluate("document.querySelector('#list button').textContent = 'Beta'");
    expect(await d.perform({ method: "click", target })).toMatchObject({ ok: false, reason: "lost" });
    await page.close();
  });

  it("answers a confirm no, unless the step is an approved submit", async () => {
    const page = await browser.newPage();
    const d = new PageDriver(page);
    await d.perform({ method: "goto", args: [`${web.base}/dialog`] });
    const view = await d.look();
    const ask = idOf(view.outline, /button: Ask me/);
    const r = await d.perform({ method: "click", id: ask });
    expect(r).toMatchObject({ ok: true, dialogs: ["confirm: Sure?"] });
    expect((await d.look()).outline).toContain("StaticText: no");
    await page.close();
  });

  it("saves a download, follows a new tab, and hides a secret", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dl-"));
    const page = await browser.newPage();
    const d = new PageDriver(page, { downloadsDir: dir });
    await d.perform({ method: "goto", args: [`${web.base}/file`] });
    let view = await d.look();
    const got = await d.perform({ method: "click", id: idOf(view.outline, /link: Get the report/) });
    expect(got.ok && got.downloads?.[0]).toBeTruthy();
    expect(readFileSync((got as { downloads: string[] }).downloads[0], "utf8")).toContain("1,2");

    const tab = await d.perform({ method: "click", id: idOf(view.outline, /link: Open elsewhere/) });
    expect(tab).toMatchObject({ ok: true, newTab: true, title: "Done" });

    await d.perform({ method: "goto", args: [`${web.base}/form`] });
    view = await d.look();
    await d.perform({ method: "fill", id: idOf(view.outline, /textbox: Email/), args: ["s3cret-value"], secret: true });
    view = await d.look();
    expect(view.outline).not.toContain("s3cret-value");
    expect(view.outline).toContain('value="(hidden)"');
    await page.close();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import type { LLMMessage, LLMProvider } from "../../src/types.js";
import { BrowserPilot, PageDriver, parseRoutine } from "../../src/browser/index.js";
import { chromiumPath, launch, site } from "./helpers.js";

const hasBrowser = !!(await chromiumPath());

/** A stand-in model that follows simple rules: the element is named in
 *  quotes in the instruction, the method is its first word. `aliases` lets a
 *  test rename things, as a redesign would, so only a model that reads the
 *  instruction afresh (not the recording) can find them. */
const ruleModel = () => {
  const seen: string[] = [];
  const aliases: Record<string, string> = {};
  let calls = 0;
  const lineId = (outline: string, label: string, role?: string): string | null => {
    const l = outline.split("\n").find((x) => new RegExp(`\\] ${role ?? "[\\w]+"}: ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(x.trim()));
    return l?.match(/\[(\d+-\d+)\]/)?.[1] ?? null;
  };
  const llm: LLMProvider = {
    async complete(messages: LLMMessage[]) {
      calls++;
      const all = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      seen.push(all);
      const system = String(messages[0].content);
      const user = String(messages[1].content);
      const outline = user.slice(user.indexOf("\n\nPage: "));
      if (system.startsWith("You choose")) {
        const instruction = user.match(/^Instruction: (.*)$/m)![1];
        const quoted = [...instruction.matchAll(/"([^"]+)"/g)].map((m) => aliases[m[1]] ?? m[1]);
        const verb = instruction.split(" ")[0];
        if (verb === "choose") {
          // A custom dropdown: open it, then pick.
          if (!/Already done/.test(user)) return JSON.stringify({ elementId: lineId(outline, quoted[1], "combobox"), method: "click", args: [], description: `the ${quoted[1]} dropdown`, twoStep: true });
          return JSON.stringify({ elementId: lineId(outline, quoted[0], "option"), method: "click", args: [], description: `the ${quoted[0]} option` });
        }
        const id = lineId(outline, verb === "fill" ? quoted[0] : quoted[0]);
        if (!id) return JSON.stringify({ elementId: null, reason: `no "${quoted[0]}"` });
        const args = verb === "fill" ? [instruction.match(/%\w+%/)?.[0] ?? quoted[1]] : [];
        return JSON.stringify({ elementId: id, method: verb, args, description: `the ${quoted[0]} ${verb === "fill" ? "field" : "button"}` });
      }
      if (system.startsWith("You list")) {
        const ids = [...outline.matchAll(/\[(\d+-\d+)\] button: (.*)/g)].map((m) => ({ elementId: m[1], description: m[2], method: "click", args: [] }));
        return JSON.stringify({ elements: ids });
      }
      if (system.startsWith("You read")) {
        const total = outline.match(/StaticText: Total (\S+)/)?.[1] ?? null;
        return `Here you go:\n\`\`\`json\n${JSON.stringify({ data: { total } })}\n\`\`\``;
      }
      return "{}";
    },
    async *stream() {
      yield { delta: "", done: true };
    },
  };
  return { llm, seen, aliases, calls: () => calls };
};

describe.skipIf(!hasBrowser)("BrowserPilot", { timeout: 60_000 }, () => {
  let browser: Browser;
  let web: Awaited<ReturnType<typeof site>>;
  let design = 1;

  beforeAll(async () => {
    browser = await launch();
    web = await site({
      "/login": () =>
        design === 1
          ? `<!doctype html><title>Sign in</title>
             <label>Email <input name="email"></label>
             <label>Password <input type="password" name="pw"></label>
             <button type="button" onclick="location.href='/home?who=' + encodeURIComponent(document.querySelector('[name=email]').value)">Continue</button>`
          : design === 2
            ? // A redesign: new wrappers, fields reordered, same controls.
              `<!doctype html><title>Sign in</title><main><section class="card"><div>
             <label>Password <input type="password" name="pw"></label></div><div>
             <label>Email <input name="email"></label></div>
             <footer><button type="button" onclick="location.href='/home?who=' + encodeURIComponent(document.querySelector('[name=email]').value)">Continue</button></footer></section></main>`
            : // Renamed: the button now says Next, and its position changed.
              `<!doctype html><title>Sign in</title><p>Welcome back</p>
             <label>Email <input name="email"></label>
             <label>Password <input type="password" name="pw"></label>
             <div><button type="button" onclick="location.href='/home?who=' + encodeURIComponent(document.querySelector('[name=email]').value)">Next</button></div>`,
      "/home": (u) => `<!doctype html><title>Home</title><p>Hello ${u.searchParams.get("who")}</p><p>Total £42.10</p>
        <form action="/sent"><label>Message <input name="m"></label><button>Send</button></form>
        <div role="combobox" aria-label="Plan" tabindex="0" onclick="document.getElementById('opts').hidden = false">Plan</div>
        <div id="opts" role="listbox" hidden><div role="option" onclick="document.getElementById('pick').textContent='picked '+this.textContent">Basic</div><div role="option" onclick="document.getElementById('pick').textContent='picked '+this.textContent">Pro</div></div>
        <p id="pick">none</p>`,
      "/sent": (u) => `<!doctype html><title>Sent</title><p>Sent: ${u.searchParams.get("m")}</p>`,
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await web?.close();
  });

  const signIn = async (pilot: BrowserPilot, email: string, pw: string) => {
    expect((await pilot.goto(`${web.base}/login`)).ok).toBe(true);
    const vars = { email, pw: { value: pw, secret: true } };
    expect((await pilot.act('fill %email% into "Email"', { variables: vars })).ok).toBe(true);
    expect((await pilot.act('fill %pw% into "Password"', { variables: vars })).ok).toBe(true);
    const go = await pilot.act('click "Continue"', { variables: vars });
    expect(go).toMatchObject({ ok: true, title: "Home" });
  };

  it("records a task, then replays it with no model calls, for another person", async () => {
    design = 1;
    const m = ruleModel();
    const page = await browser.newPage();
    const pilot = new BrowserPilot({ driver: new PageDriver(page), llm: m.llm });
    pilot.startRecording();
    await signIn(pilot, "ann@x.co", "pw-ann-123");
    const routine = parseRoutine(JSON.parse(JSON.stringify(pilot.stopRecording({ name: "sign in", variables: [{ name: "pw", secret: true }] }))));
    expect(routine.steps.map((s) => s.kind)).toEqual(["goto", "act", "act", "act"]);
    expect(routine.variables).toEqual([{ name: "email" }, { name: "pw", secret: true }]);
    expect(JSON.stringify(routine)).not.toContain("ann@x.co");

    const before = m.calls();
    const r = await pilot.replay(routine, { email: "bob@x.co", pw: { value: "pw-bob-456", secret: true } });
    expect(r).toMatchObject({ ok: true, done: 4, modelCalls: 0, changed: false });
    expect(m.calls()).toBe(before);
    expect((await pilot.look()).outline).toContain("Hello bob@x.co");

    // No secret ever reached the model, and neither did it reach the page's
    // outline read back.
    expect(m.seen.join("\n")).not.toContain("pw-ann-123");
    expect(m.seen.join("\n")).toContain("%pw%");
    await page.close();
  });

  it("replays through a redesign without asking the model", async () => {
    design = 1;
    const m = ruleModel();
    const page = await browser.newPage();
    const pilot = new BrowserPilot({ driver: new PageDriver(page), llm: m.llm });
    pilot.startRecording();
    await signIn(pilot, "ann@x.co", "a");
    const routine = pilot.stopRecording({ name: "sign in" });

    design = 2;
    const r = await pilot.replay(routine, { email: "cat@x.co", pw: "b" });
    expect(r.ok).toBe(true);
    expect(r.modelCalls).toBe(0);
    expect(r.reports.filter((x) => x.status === "moved").length).toBeGreaterThanOrEqual(2);
    expect(r.changed).toBe(true);
    expect((await pilot.look()).outline).toContain("Hello cat@x.co");
    await page.close();
  });

  it("asks the model once when a control is renamed, and keeps the fix", async () => {
    design = 1;
    const m = ruleModel();
    const page = await browser.newPage();
    const pilot = new BrowserPilot({ driver: new PageDriver(page), llm: m.llm });
    pilot.startRecording();
    await signIn(pilot, "ann@x.co", "a");
    const routine = pilot.stopRecording({ name: "sign in" });

    design = 3;
    m.aliases.Continue = "Next";
    const r = await pilot.replay(routine, { email: "dan@x.co", pw: "b" }, { waitMs: 500 });
    expect(r).toMatchObject({ ok: true, modelCalls: 1, changed: true });
    expect(r.reports[3]).toMatchObject({ status: "healed" });
    expect((await pilot.look()).outline).toContain("Hello dan@x.co");

    // The healed routine now runs as it is, with no model.
    const again = await pilot.replay(r.routine, { email: "eve@x.co", pw: "c" });
    expect(again).toMatchObject({ ok: true, modelCalls: 0 });
    await page.close();
  });

  it("stops a replay at a submit, with the step to approve, and resumes when approved", async () => {
    design = 1;
    const m = ruleModel();
    const page = await browser.newPage();
    const pilot = new BrowserPilot({ driver: new PageDriver(page), llm: m.llm });
    await pilot.goto(`${web.base}/home?who=x`);
    pilot.startRecording();
    await pilot.act('fill %msg% into "Message"', { variables: { msg: "hi" } });
    const send = await pilot.act('click "Send"');
    expect(send).toMatchObject({ ok: false, reason: "submits" });
    const pending = (send as { pending: Parameters<BrowserPilot["runStep"]>[0] }).pending;
    expect(pending).toMatchObject({ method: "click", submits: true, target: { fp: { label: "Send" } } });
    // A person approves: the very step proposed is done.
    expect(await pilot.runStep(pending, { allowSubmit: true })).toMatchObject({ ok: true, title: "Sent", submitted: true });
    const routine = pilot.stopRecording({ name: "send a message" });
    expect(routine.steps.at(-1)).toMatchObject({ submits: true });

    await pilot.goto(`${web.base}/home?who=x`);
    const r = await pilot.replay(routine, { msg: "again" });
    expect(r).toMatchObject({ ok: false, done: 1, stopped: { at: 1, reason: "submits" } });
    const resumed = await pilot.replay(routine, { msg: "again" }, { from: 1, approved: [1] });
    expect(resumed).toMatchObject({ ok: true, done: 2 });
    expect((await pilot.look()).outline).toContain("Sent: again");
    await page.close();
  });

  it("opens a custom dropdown and picks, in two recorded steps", async () => {
    const m = ruleModel();
    const page = await browser.newPage();
    const pilot = new BrowserPilot({ driver: new PageDriver(page), llm: m.llm });
    await pilot.goto(`${web.base}/home?who=x`);
    pilot.startRecording();
    const r = await pilot.act('choose "Pro" in "Plan"');
    expect(r).toMatchObject({ ok: true });
    expect((r as { steps: unknown[] }).steps).toHaveLength(2);
    expect((await pilot.look()).outline).toContain("picked Pro");
    const routine = pilot.stopRecording({ name: "pick pro" });

    await pilot.goto(`${web.base}/home?who=x`);
    const again = await pilot.replay(routine);
    expect(again).toMatchObject({ ok: true, modelCalls: 0 });
    expect((await pilot.look()).outline).toContain("picked Pro");
    await page.close();
  });

  it("reads data off the page, observes what can be done, and says when nothing fits", async () => {
    const m = ruleModel();
    const page = await browser.newPage();
    const pilot = new BrowserPilot({ driver: new PageDriver(page), llm: m.llm });
    await pilot.goto(`${web.base}/home?who=x`);
    const got = await pilot.extract("the order total", { schema: { type: "object", required: ["total"], properties: { total: { type: "string" } } } });
    expect(got).toEqual({ ok: true, data: { total: "£42.10" } });
    const obs = await pilot.observe("buttons");
    expect(obs.map((o) => o.description)).toContain("Send");
    const none = await pilot.act('click "Refund everything"');
    expect(none).toMatchObject({ ok: false, reason: "not-found" });
    await page.close();
  });
});

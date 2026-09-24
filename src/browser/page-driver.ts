import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Download, Frame, Locator, Page } from "playwright-core";
import { isElementMethod, isPageMethod, type BrowserDriver, type DriverStep, type PageView, type StepOutcome } from "./driver.js";
import type { Target } from "./fingerprint.js";
import { resolveTarget, type Resolution } from "./resolve.js";
import { captureSnapshot, ownerOf, type PageSnapshot, type SnapshotElement } from "./snapshot.js";

// A driver over a Playwright page in this process. Every element step reads
// the page afresh and finds its element again before touching it, so a step
// taken a minute after the look (or a day after, in a routine) presses the
// control it means or nothing.

/** Where the last look's targets are kept between steps. In memory by
 *  default; a caller that runs each step in a new process keeps them on disk. */
export interface TargetMemory {
  load(): Record<string, Target> | null;
  save(targets: Record<string, Target>): void;
}

/** Secrets typed so far, as hashes: a field showing one reads as hidden. */
export interface SecretMemory {
  has(value: string): boolean;
  add(value: string): void;
}

export interface PageDriverOptions {
  /** The longest outline a look returns. Default 50,000 characters. */
  maxChars?: number;
  memory?: TargetMemory;
  secrets?: SecretMemory;
  /** Save downloads here; without it a download is left to the browser. */
  downloadsDir?: string;
  /** How long one action may wait for its element to be ready. Default 10s. */
  timeoutMs?: number;
}

/** A cheap stable hash (FNV-1a): what is kept of a secret. */
export const fnv = (v: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
};

const memorySecrets = (): SecretMemory => {
  const seen = new Set<string>();
  return { has: (v) => seen.has(fnv(v)), add: (v) => void seen.add(fnv(v)) };
};

const memoryTargets = (): TargetMemory => {
  let kept: Record<string, Target> | null = null;
  return { load: () => kept, save: (t) => void (kept = t) };
};

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 400);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PageDriver implements BrowserDriver {
  page: Page;
  private readonly memory: TargetMemory;
  private readonly secrets: SecretMemory;
  private readonly opts: PageDriverOptions;
  private dialogs: string[] = [];
  private submitting = false;
  private readonly answering = new WeakSet<Page>();

  constructor(page: Page, opts: PageDriverOptions = {}) {
    this.page = page;
    this.opts = opts;
    this.memory = opts.memory ?? memoryTargets();
    this.secrets = opts.secrets ?? memorySecrets();
  }

  private snapshot(): Promise<PageSnapshot> {
    return captureSnapshot(this.page, { maxChars: this.opts.maxChars, hideValue: (v) => this.secrets.has(v) });
  }

  async look(): Promise<PageView> {
    this.answerDialogs(this.page);
    const snap = await this.snapshot();
    this.memory.save(Object.fromEntries(Object.values(snap.elements).map((e) => [e.id, e.target])));
    return { url: snap.url, title: snap.title, outline: snap.outline, truncated: snap.truncated };
  }

  async perform(step: DriverStep): Promise<StepOutcome> {
    this.dialogs = [];
    this.answerDialogs(this.page);
    try {
      if (isPageMethod(step.method)) return await this.pageStep(step);
      if (!isElementMethod(step.method)) return { ok: false, reason: "refused", error: `no step "${step.method}"` };
      return await this.elementStep(step);
    } catch (e) {
      return { ok: false, reason: "failed", error: firstLine(e), url: this.page.url() };
    }
  }

  /** Alert, confirm and prompt stop a page until answered. An alert is
   *  noted, a prompt gets nothing, and a confirm says no unless an approved
   *  submit is under way: then it is the "are you sure" of that very submit. */
  private answerDialogs(page: Page): void {
    if (this.answering.has(page)) return;
    this.answering.add(page);
    page.on("dialog", (d) => {
      const yes = this.submitting && d.type() === "confirm";
      this.dialogs.push(`${d.type()}${yes ? " (accepted)" : ""}: ${d.message().slice(0, 200)}`);
      void (yes ? d.accept() : d.dismiss()).catch(() => undefined);
    });
  }

  /** Let the page finish what a step started. A step that can navigate or
   *  fetch (a click, a key, a goto) waits for the network to go quiet too;
   *  one that only edits the page (typing, ticking) does not need to. */
  private async settle(full = true): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    if (full) await this.page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  }

  private async done(extra: { target?: Target; label?: string; found?: "same" | "moved"; downloads?: string[]; newTab?: boolean; submitted?: boolean } = {}): Promise<StepOutcome> {
    return {
      ok: true,
      ...extra,
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      ...(this.dialogs.length ? { dialogs: [...this.dialogs] } : {}),
    };
  }

  /** Run an action that may start a download or open a tab, and follow what
   *  it did. No fixed wait: whatever started while the page settled counts. */
  private async pressing(action: () => Promise<void>, full = true): Promise<{ downloads?: string[]; newTab?: boolean }> {
    const popup = full ? this.page.waitForEvent("popup", { timeout: 400 }).catch(() => null) : Promise.resolve(null);
    const started: Download[] = [];
    const opened: Page[] = [];
    const onDownload = (d: Download) => void started.push(d);
    const onPage = (p: Page) => void opened.push(p);
    this.page.on("download", onDownload);
    this.page.context().on("page", onPage);
    try {
      await action();
      await this.settle(full);
      // A tab opened by the step can arrive just after it: allow it a moment.
      const p = await popup;
      if (p && !opened.includes(p)) opened.push(p);
    } finally {
      this.page.off("download", onDownload);
      this.page.context().off("page", onPage);
    }
    const out: { downloads?: string[]; newTab?: boolean } = {};
    if (started.length && this.opts.downloadsDir) {
      mkdirSync(this.opts.downloadsDir, { recursive: true });
      out.downloads = [];
      for (const d of started) {
        const name = d.suggestedFilename().replace(/[^\w.@+-]+/g, "_").slice(0, 120) || "download";
        let dest = path.join(this.opts.downloadsDir, name);
        for (let i = 2; existsSync(dest); i++) dest = path.join(this.opts.downloadsDir, name.replace(/(\.[^.]*)?$/, `-${i}$1`));
        // A file saved half way is worse than none, so this waits for it.
        await d.saveAs(dest);
        out.downloads.push(dest);
      }
    }
    if (opened.length) {
      this.page = opened[opened.length - 1];
      this.answerDialogs(this.page);
      await this.settle();
      out.newTab = true;
    }
    return out;
  }

  private async pageStep(step: DriverStep): Promise<StepOutcome> {
    const arg = step.args?.[0] ?? "";
    switch (step.method) {
      case "goto": {
        if (!/^https?:\/\//i.test(arg)) return { ok: false, reason: "refused", error: "goto needs an http(s) URL" };
        const r = await this.pressing(async () => {
          await this.page.goto(arg, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((e: Error) => {
            // A link straight to a file starts a download instead of a page.
            if (!/Download is starting/i.test(e.message)) throw e;
          });
        });
        return this.done(r);
      }
      case "back":
        await this.page.goBack({ timeout: 15_000 }).catch(() => undefined);
        await this.settle();
        return this.done();
      case "scroll": {
        const dir = arg.toLowerCase();
        const how = dir === "top" ? "window.scrollTo(0, 0)" : dir === "bottom" ? "window.scrollTo(0, document.body.scrollHeight)" : `window.scrollBy(0, ${dir === "up" ? -0.9 : 0.9} * window.innerHeight)`;
        await this.page.evaluate(how);
        return this.done();
      }
      case "wait": {
        // A number is a pause; anything else is text to wait for.
        if (/^\d+$/.test(arg)) {
          await sleep(Math.min(30_000, Number(arg)));
          return this.done();
        }
        const want = arg.toLowerCase();
        const deadline = Date.now() + Math.min(60_000, step.waitMs ?? 10_000);
        for (;;) {
          const snap = await this.snapshot().catch(() => null);
          if (snap && snap.outline.toLowerCase().includes(want)) return this.done();
          if (Date.now() > deadline) return { ok: false, reason: "failed", error: `the page still does not show ${JSON.stringify(arg)}`, url: this.page.url() };
          await sleep(400);
        }
      }
    }
    return { ok: false, reason: "refused", error: `no step "${step.method}"` };
  }

  /** The element a step means, on the page as it is now. */
  private find(snap: PageSnapshot, step: DriverStep): Resolution | null {
    const remembered = step.id ? this.memory.load()?.[step.id] : undefined;
    const want = step.target ?? remembered;
    if (want) return resolveTarget(snap, want, step.id);
    const el = step.id ? snap.elements[step.id] : undefined;
    return el ? { element: el, found: "same" } : null;
  }

  private async elementStep(step: DriverStep): Promise<StepOutcome> {
    if (!step.id && !step.target) return { ok: false, reason: "refused", error: `${step.method} needs an element: its id from the page, or a recorded target` };
    const deadline = Date.now() + Math.min(60_000, step.waitMs ?? 0);
    let snap = await this.snapshot();
    let hit = this.find(snap, step);
    while (!hit && Date.now() < deadline) {
      await sleep(400);
      snap = await this.snapshot();
      hit = this.find(snap, step);
    }
    if (!hit) {
      const was = step.target ?? (step.id ? this.memory.load()?.[step.id] : undefined);
      return { ok: false, reason: "lost", error: `the element${was ? ` "${was.fp.label}"` : step.id ? ` [${step.id}]` : ""} is not on the page now, or cannot be told apart from another`, url: snap.url, ...(was ? { target: was } : {}) };
    }
    const el = hit.element;
    const args = step.args ?? [];
    const text = args[0] ?? "";

    if ((step.method === "fill" || step.method === "type") && el.tag !== "textarea" && /[\r\n]/.test(text)) {
      return { ok: false, reason: "refused", error: "typing never presses Enter: type the text, then press Enter as its own step", target: el.target, label: el.name };
    }
    const commits =
      ((step.method === "click" || step.method === "doubleClick") && el.submits) ||
      (step.method === "press" && /^(enter|numpadenter)$/i.test(text) && (el.enterSubmits || el.submits));
    if (commits && !step.allowSubmit) {
      return { ok: false, reason: "submits", error: `"${el.name || el.role}" submits something (it sends a form, pays, confirms, deletes...): propose it for approval`, target: el.target, label: el.name, url: snap.url };
    }

    const loc = await this.locate(snap, el);
    const timeout = this.opts.timeoutMs ?? 10_000;
    this.submitting = commits;
    try {
      const r = await this.pressing(async () => {
        switch (step.method) {
          case "click":
            await loc.click({ timeout });
            break;
          case "doubleClick":
            await loc.dblclick({ timeout });
            break;
          case "hover":
            await loc.hover({ timeout });
            break;
          case "fill":
            await loc.fill(text, { timeout });
            break;
          case "type":
            await loc.pressSequentially(text, { delay: 15, timeout });
            break;
          case "press":
            await loc.press(text || "Enter", { timeout });
            break;
          case "selectOption": {
            if (el.tag !== "select") throw new Error("selectOption is for a select; for another kind of dropdown, click it open and click the option");
            await loc.selectOption({ label: text }, { timeout }).catch(() => loc.selectOption(text, { timeout }));
            break;
          }
          case "check":
            await loc.check({ timeout });
            break;
          case "uncheck":
            await loc.uncheck({ timeout });
            break;
          case "scrollIntoView":
            await loc.scrollIntoViewIfNeeded({ timeout });
            break;
        }
      }, ["click", "doubleClick", "press"].includes(step.method));
      if (step.secret && (step.method === "fill" || step.method === "type")) this.secrets.add(text);
      // Tidy the mark, if the element is still there (a submit may have left the page).
      await loc.evaluate((e) => e.removeAttribute("data-minns-el"), undefined, { timeout: 300 }).catch(() => undefined);
      return this.done({ target: el.target, label: el.name, found: hit.found, ...(commits ? { submitted: true } : {}), ...r });
    } finally {
      this.submitting = false;
    }
  }

  /** A Playwright locator for a snapshot element: mark the node through the
   *  DevTools session that owns its frame, then find the mark. Playwright's
   *  CSS reaches into shadow roots, and it knows where each frame is drawn. */
  private async locate(snap: PageSnapshot, el: SnapshotElement): Promise<Locator> {
    const [ordinal, backend] = el.id.split("-").map(Number);
    const owner = ownerOf(snap, ordinal);
    if (!owner) throw new Error("that element's frame has gone");
    const session = await this.page.context().newCDPSession(owner);
    const mark = Math.random().toString(36).slice(2, 10);
    try {
      const { object } = (await session.send("DOM.resolveNode", { backendNodeId: backend })) as { object: { objectId?: string } };
      if (!object.objectId) throw new Error("that element has gone");
      await session.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function (m) { const e = this.nodeType === 3 ? this.parentElement : this; e.setAttribute('data-minns-el', m); }",
        arguments: [{ value: mark }],
      });
    } finally {
      await session.detach().catch(() => undefined);
    }
    const frames: Frame[] = owner === this.page ? this.page.frames() : descendants(owner as Frame);
    for (const f of frames) {
      if (f.isDetached()) continue;
      const loc = f.locator(`[data-minns-el="${mark}"]`);
      if (await loc.count().catch(() => 0)) return loc.first();
    }
    throw new Error("that element has gone");
  }
}

const descendants = (f: Frame): Frame[] => [f, ...f.childFrames().flatMap(descendants)];

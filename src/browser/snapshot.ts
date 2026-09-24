import type { CDPSession, Frame, Page } from "playwright-core";
import { COMMIT_WORDS, type Fingerprint, type FrameHop, type Target } from "./fingerprint.js";

// The page as an agent reads it: one outline of what is on it, built from the
// browser's own accessibility tree and joined to the DOM underneath.
//
// The accessibility tree is what a screen reader gets: roles and names as a
// person would describe them ("button: Sign in"), with the page's layout
// markup folded away. It is much smaller than the HTML and says what things
// are rather than how they are drawn. The DOM underneath gives each line a
// position (an XPath) and the details that make up a fingerprint, so a line
// read now can be found again later.
//
// Every line carries an id, "<frame>-<node>": the frame's number in this
// snapshot and the browser's own id for the node. Frames are walked whole:
// same-site iframes and open shadow roots come in the one DOM call, and a
// cross-site iframe (which Chromium runs in another process, with its own
// DevTools session) is fetched from that session and placed under the iframe
// that shows it. Technique after Stagehand (MIT, Browserbase).

/** One element of the page, by its id in the snapshot. */
export interface SnapshotElement {
  id: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  /** For a link, where it goes. */
  url?: string;
  /** Whether pressing it would submit or commit something: a form's submit
   *  control, or a button whose words pay, send, delete, confirm... */
  submits: boolean;
  /** A text field inside a form, where Enter submits the form. */
  enterSubmits: boolean;
  target: Target;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** The page as lines, one per element, indented by containment. */
  outline: string;
  /** Every element in the outline, by id, including those past a cut. */
  elements: Record<string, SnapshotElement>;
  /** Whether the outline was cut to fit maxChars. */
  truncated: boolean;
}

export interface SnapshotOptions {
  /** The longest outline to return. Default 50,000 characters. */
  maxChars?: number;
  /** Whether a field's value must never be read out (a secret typed earlier). */
  hideValue?: (value: string) => boolean;
}

/** Where a snapshot's elements live in this process, so they can be acted
 *  on: the page or cross-site frame whose DevTools session holds each frame
 *  number. Kept beside the snapshot, never in it, so a snapshot stays plain
 *  data that can be sent anywhere. */
const owners = new WeakMap<PageSnapshot, Map<number, Page | Frame>>();

/** The page or frame that owns frame number `ordinal` of a snapshot. */
export const ownerOf = (snap: PageSnapshot, ordinal: number): Page | Frame | undefined => owners.get(snap)?.get(ordinal);

interface DomNode {
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  frameId?: string;
  documentURL?: string;
}

interface AXValue {
  value?: unknown;
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface NodeInfo {
  tag: string;
  attrs: Record<string, string>;
  xpath: string;
  inForm: boolean;
}

interface Doc {
  ordinal: number;
  owner: Page | Frame;
  session: CDPSession;
  frameId: string;
  root: DomNode;
  hops: FrameHop[];
  site: string;
  nodes: Map<number, NodeInfo>;
  /** Child documents by the backend id of the iframe element showing them. */
  children: Map<number, Doc>;
  ax: AXNode[];
}

const DEFAULT_MAX = 50_000;

const attrsOf = (n: DomNode): Record<string, string> => {
  const out: Record<string, string> = {};
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) out[a[i]] = a[i + 1];
  return out;
};

const hostOf = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};

/** Per-sibling XPath steps: tag[n] counted among siblings of the same kind. */
const childSteps = (kids: DomNode[]): string[] => {
  const count: Record<string, number> = {};
  return kids.map((k) => {
    const tag = k.nodeName.toLowerCase();
    const key = `${k.nodeType}:${tag}`;
    const n = (count[key] = (count[key] ?? 0) + 1);
    if (k.nodeType === 3) return `text()[${n}]`;
    if (k.nodeType === 8) return `comment()[${n}]`;
    return tag.includes(":") || tag.startsWith("#") ? `*[name()='${tag}'][${n}]` : `${tag}[${n}]`;
  });
};

const join = (base: string, step: string): string => (base.endsWith("//") ? `${base}${step}` : `${base}/${step}`);

/** The DOM of one session, whole. Very deep pages can overflow the protocol's
 *  encoder at full depth; a shallower fetch is then the only answer, and the
 *  outline simply reaches less far. */
const documentOf = async (session: CDPSession): Promise<DomNode> => {
  let last: unknown;
  for (const depth of [-1, 256, 64]) {
    try {
      return ((await session.send("DOM.getDocument", { depth, pierce: true })) as { root: DomNode }).root;
    } catch (e) {
      last = e;
      if (!/stack limit/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  throw last;
};

/** Index one document's elements, and find the frames inside it. */
const indexDoc = (doc: Doc, queue: Array<Omit<Doc, "nodes" | "children" | "ax" | "ordinal">>, crossSite: Map<string, Frame>): void => {
  const stack: Array<{ node: DomNode; xpath: string; inForm: boolean }> = [{ node: doc.root, xpath: "", inForm: false }];
  while (stack.length) {
    const { node, xpath, inForm } = stack.pop()!;
    const tag = node.nodeName.toLowerCase();
    const attrs = node.nodeType === 1 ? attrsOf(node) : {};
    const formHere = inForm || tag === "form" || (node.nodeType === 1 && !!attrs.form);
    if (node.backendNodeId) doc.nodes.set(node.backendNodeId, { tag: node.nodeType === 3 ? "#text" : tag, attrs, xpath: xpath || "/", inForm: formHere });
    if ((tag === "iframe" || tag === "frame") && node.frameId) {
      const hop = { host: xpath, origin: "" };
      if (node.contentDocument) {
        // Same process: the document is already here.
        const url = node.contentDocument.documentURL ?? "";
        hop.origin = hostOf(url) || `${doc.site} (embedded)`;
        queue.push({ owner: doc.owner, session: doc.session, frameId: node.frameId, root: node.contentDocument, hops: [...doc.hops, hop], site: hop.origin, parentHost: node.backendNodeId, parent: doc } as never);
      } else if (crossSite.has(node.frameId)) {
        queue.push({ owner: crossSite.get(node.frameId)!, frameId: node.frameId, hops: [...doc.hops, hop], parentHost: node.backendNodeId, parent: doc } as never);
      }
      continue;
    }
    const kids = node.children ?? [];
    const steps = childSteps(kids);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], xpath: join(xpath, steps[i]), inForm: formHere });
    for (const sr of node.shadowRoots ?? []) stack.push({ node: sr, xpath: `${xpath}//`, inForm: formHere });
  }
};

/** Capture the page as an outline with an id on every line. */
export const captureSnapshot = async (page: Page, opts: SnapshotOptions = {}): Promise<PageSnapshot> => {
  const context = page.context();
  const sessions: CDPSession[] = [];
  try {
    // Cross-site frames: each has its own session, found by trying.
    const crossSite = new Map<string, Frame>();
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.isDetached()) continue;
      const s = await context.newCDPSession(f).catch(() => null);
      if (!s) continue;
      const tree = (await s.send("Page.getFrameTree").catch(() => null)) as { frameTree: { frame: { id: string } } } | null;
      await s.detach().catch(() => undefined);
      if (tree) crossSite.set(tree.frameTree.frame.id, f);
    }

    const main = await context.newCDPSession(page);
    sessions.push(main);
    const mainTree = (await main.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    const docs: Doc[] = [];
    type Pending = Partial<Doc> & { owner: Page | Frame; frameId: string; hops: FrameHop[]; parentHost?: number; parent?: Doc };
    const queue: Pending[] = [{ owner: page, session: main, frameId: mainTree.frameTree.frame.id, hops: [], site: hostOf(page.url()) }];
    while (queue.length && docs.length < 60) {
      const p = queue.shift()!;
      let session = p.session;
      let root = p.root;
      if (!session) {
        session = await context.newCDPSession(p.owner as Frame).catch(() => undefined);
        if (!session) continue;
        sessions.push(session);
      }
      if (!root) root = await documentOf(session).catch(() => undefined);
      if (!root) continue;
      const site = p.site ?? (hostOf(root.documentURL ?? "") || `${p.parent?.site ?? ""} (embedded)`);
      if (p.hops.length) p.hops[p.hops.length - 1].origin = site;
      const doc: Doc = { ordinal: docs.length, owner: p.owner, session, frameId: p.frameId, root, hops: p.hops, site, nodes: new Map(), children: new Map(), ax: [] };
      docs.push(doc);
      if (p.parent && p.parentHost !== undefined) p.parent.children.set(p.parentHost, doc);
      indexDoc(doc, queue as never, crossSite);
      doc.ax = (((await session.send("Accessibility.getFullAXTree", { frameId: p.frameId }).catch(() => session!.send("Accessibility.getFullAXTree").catch(() => null))) as { nodes: AXNode[] } | null)?.nodes) ?? [];
    }

    const elements: Record<string, SnapshotElement> = {};
    const lines: string[] = [];
    let used = 0;
    let truncated = false;
    const max = opts.maxChars ?? DEFAULT_MAX;
    const push = (line: string) => {
      if (truncated) return;
      if (used + line.length + 1 > max) {
        truncated = true;
        return;
      }
      lines.push(line);
      used += line.length + 1;
    };

    const tree = renderDoc(docs[0], opts);
    for (const node of tree) emit(node, 0, push, elements);
    if (truncated) lines.push(`(the outline was cut at ${max} characters; scroll or ask about a part of the page to see more)`);

    const title = await page.title().catch(() => "");
    const snap: PageSnapshot = { url: page.url(), title, outline: lines.join("\n"), elements, truncated };
    owners.set(snap, new Map(docs.map((d) => [d.ordinal, d.owner])));
    return snap;
  } finally {
    for (const s of sessions) await s.detach().catch(() => undefined);
  }
};

interface Rendered {
  line: string;
  el?: SnapshotElement;
  children: Rendered[];
}

/** Roles that are layout, not content: folded away, their children kept. */
const STRUCTURAL = new Set(["generic", "none", "presentation", "", "LineBreak", "MenuListPopup"]);

const cleanText = (s: string): string =>
  s
    .replace(/[-]/g, "")
    .replace(/[   ﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const prop = (n: AXNode, name: string): unknown => n.properties?.find((p) => p.name === name)?.value?.value;

const lastSteps = (xpath: string, n = 4): string => {
  const parts = xpath.split("/").filter(Boolean);
  return parts.slice(-n).join("/");
};

/** One document's accessibility tree as rendered lines, recording each
 *  element with an id as it goes, and a child document's lines under the
 *  iframe that shows it. */
const renderDoc = (doc: Doc, opts: SnapshotOptions): Rendered[] => {
  const byId = new Map(doc.ax.map((n) => [n.nodeId, n]));
  const idOf = (be: number) => `${doc.ordinal}-${be}`;

  const describe = (n: AXNode, role: string, name: string, value: string | undefined, url: string | undefined): SnapshotElement | undefined => {
    const be = n.backendDOMNodeId;
    if (be === undefined) return undefined;
    const info = doc.nodes.get(be);
    if (!info) return undefined;
    const id = idOf(be);
    const type = (info.attrs.type ?? "").toLowerCase();
    const fp: Fingerprint = { tag: info.tag, role, label: name.slice(0, 80), path: lastSteps(info.xpath) };
    if (type) fp.type = type;
    if (info.attrs.name) fp.name = info.attrs.name;
    if (info.attrs.id) fp.id = info.attrs.id;
    const testid = info.attrs["data-testid"] ?? info.attrs["data-test"] ?? info.attrs["data-qa"];
    if (testid) fp.testid = testid;
    if (doc.hops.length) fp.frame = doc.site;
    const tag = info.tag;
    const submitsByMarkup = (tag === "button" && (type === "" || type === "submit") && info.inForm) || (tag === "input" && (type === "submit" || type === "image"));
    const clickable = tag === "button" || tag === "a" || type === "submit" || type === "button" || role === "button" || role === "link" || role === "menuitem";
    const submits = submitsByMarkup || (clickable && COMMIT_WORDS.test(name));
    const textField = (tag === "input" && !["submit", "button", "checkbox", "radio", "file", "image", "reset"].includes(type)) || role === "textbox" || role === "searchbox";
    return {
      id,
      role,
      name,
      tag,
      ...(value !== undefined ? { value } : {}),
      ...(url ? { url } : {}),
      submits,
      enterSubmits: textField && tag !== "textarea" && info.inForm,
      target: { frames: doc.hops, xpath: info.xpath, fp },
    };
  };

  const render = (n: AXNode): Rendered[] => {
    let role = String(n.role?.value ?? "");
    if (role === "InlineTextBox" || role === "ListMarker") return [];
    const ignored = n.ignored;
    const name = ignored ? "" : cleanText(String(n.name?.value ?? ""));
    const kids = (n.childIds ?? []).flatMap((c) => {
      const child = byId.get(c);
      return child ? render(child) : [];
    });
    // An iframe's lines: the document it shows.
    const be = n.backendDOMNodeId;
    const childDoc = be !== undefined ? doc.children.get(be) : undefined;
    if (childDoc) kids.push(...renderDoc(childDoc, opts));

    const info = be !== undefined ? doc.nodes.get(be) : undefined;
    const structural = ignored || STRUCTURAL.has(role);
    if (structural && !childDoc) {
      if (!kids.length) return [];
      if (kids.length === 1) return kids;
      role = info?.tag && !info.tag.startsWith("#") ? info.tag : "group";
    }
    if (role === "combobox" && info?.tag === "select") role = "select";
    if (role === "Iframe") role = "iframe";
    // Text repeated by the children adds nothing to a named parent.
    let children = kids;
    if (name && kids.length) {
      const texts = kids.filter((k) => k.line.includes("] StaticText: "));
      const joined = texts.map((k) => k.line.slice(k.line.indexOf("StaticText: ") + 12)).join("");
      if (texts.length && joined.replace(/\s+/g, "") === name.replace(/\s+/g, "")) children = kids.filter((k) => !texts.includes(k));
    }
    if (role === "StaticText" && !name) return children;
    // A field's own text is its value, already on its line.
    const shown = n.value?.value;
    if (shown !== undefined && shown !== null && shown !== "") {
      const v = cleanText(String(shown));
      children = children.filter((k) => !k.line.endsWith(`] StaticText: ${v}`));
    }

    // What a field holds; never a password, never a secret typed earlier.
    let value: string | undefined;
    const raw = n.value?.value;
    if (raw !== undefined && raw !== null && raw !== "" && !ignored) {
      const v = String(raw);
      const password = info?.tag === "input" && (info.attrs.type ?? "").toLowerCase() === "password";
      value = password || opts.hideValue?.(v) ? "(hidden)" : v.slice(0, 200);
    } else if (info?.tag === "input" && (info.attrs.type ?? "").toLowerCase() === "password" && raw) value = "(hidden)";
    const url = role === "link" ? (prop(n, "url") as string | undefined) : undefined;

    const el = describe(n, role, name, value, url);
    const id = el?.id;
    const flags: string[] = [];
    if (prop(n, "checked") === "true" || prop(n, "checked") === true) flags.push("checked");
    if (prop(n, "selected") === true) flags.push("selected");
    if (prop(n, "expanded") === true) flags.push("expanded");
    if (prop(n, "disabled") === true) flags.push("disabled");
    if (prop(n, "required") === true) flags.push("required");
    let line = `${id ? `[${id}] ` : ""}${role}${name ? `: ${name.slice(0, 200)}` : ""}`;
    if (value !== undefined) line += ` value=${JSON.stringify(value)}`;
    if (url) line += ` -> ${url.slice(0, 150)}`;
    if (flags.length) line += ` [${flags.join(", ")}]`;
    return [{ line, el, children }];
  };

  const roots = doc.ax.filter((n) => !n.parentId || !byId.has(n.parentId));
  return roots.flatMap(render);
};

/** Write a line and its children, and know each element whether or not
 *  its line fits. */
const emit = (r: Rendered, depth: number, push: (line: string) => void, elements: Record<string, SnapshotElement>): void => {
  push(`${"  ".repeat(depth)}${r.line}`);
  if (r.el) elements[r.el.id] = r.el;
  for (const c of r.children) emit(c, depth + 1, push, elements);
};

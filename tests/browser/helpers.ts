import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright-core";

/** A Chromium to test against: MINNS_CHROMIUM_PATH, the one Playwright
 *  installed, or a system one. None means the browser tests are skipped. */
export const chromiumPath = async (): Promise<string | null> => {
  const known = [process.env.MINNS_CHROMIUM_PATH, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const p of known) if (p && existsSync(p)) return p;
  try {
    const { chromium } = await import("playwright-core");
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
};

export const launch = async (): Promise<Browser> => {
  const { chromium } = await import("playwright-core");
  const executablePath = (await chromiumPath())!;
  return chromium.launch({ executablePath, args: ["--no-sandbox"] });
};

/** A tiny site: path -> HTML. Returns its base URL (127.0.0.1) and an
 *  alternative base on another site (localhost), for cross-site frames. */
export const site = async (pages: Record<string, string | ((url: URL) => string)>): Promise<{ base: string; other: string; close: () => Promise<void>; hits: string[] }> => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    const page = pages[url.pathname];
    if (page === undefined) {
      res.statusCode = 404;
      res.end("no");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(typeof page === "function" ? page(url) : page);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    other: `http://localhost:${port}`,
    hits,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
};

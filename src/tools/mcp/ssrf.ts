import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Resolve-then-validate guard for outbound MCP connections: resolve the host and
// reject any private / loopback / link-local address before we connect, so a
// hostile or misconfigured MCP URL can't be used to reach internal services.
// (DNS-rebinding is not fully closed here — pinning the resolved IP for the
// actual request is a follow-up; this rejects the obvious SSRF targets.)

const isPrivateIPv4 = (ip: string): boolean => {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    a >= 224 // multicast / reserved
  );
};

const isPrivateIPv6 = (ip: string): boolean => {
  const l = ip.toLowerCase();
  if (l === "::1" || l === "::") return true;
  if (l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true; // link-local / ULA
  const mapped = l.startsWith("::ffff:") ? l.slice(7) : null; // IPv4-mapped
  if (mapped && isIP(mapped) === 4) return isPrivateIPv4(mapped);
  return false;
};

const isPrivateAddress = (ip: string): boolean =>
  isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);

/** Throws if the URL is not a public http(s) endpoint. */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid MCP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP URL must be http(s)");
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("MCP URL points at a private address");
    return;
  }
  const results = await lookup(host, { all: true });
  if (results.length === 0) throw new Error("MCP host did not resolve");
  for (const r of results) {
    if (isPrivateAddress(r.address)) {
      throw new Error("MCP host resolves to a private address");
    }
  }
}

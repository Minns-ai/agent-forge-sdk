/**
 * Regex deny-list evaluated BEFORE any model sees the message.
 *
 * A model can be argued with; a regex cannot. The safety gate is a zero-cost,
 * deterministic screen that runs ahead of intent classification: a message
 * that matches a deny pattern is refused outright, and one that matches a
 * confirm pattern is bounced back for explicit confirmation — before a single
 * token is spent and before any prompt-injection has a model to inject into.
 *
 * It is deliberately dumb. It catches the small set of catastrophic bulk
 * operations ("delete all…", "DROP TABLE", "send to everyone") whose false-
 * negative cost is unbounded and whose false-positive cost is one clarifying
 * question. Everything subtler stays with the model-side policy layer
 * (`ToolPolicy` / `checkAccess`) — the gate complements it, it does not
 * replace it.
 *
 * Usage — call it before `agent.run()`:
 * ```ts
 * const gate = new SafetyGate();               // en + de defaults
 * const check = assertAllowed(gate, userMessage);
 * if (check.action === "deny")    return refuse(check.pattern);
 * if (check.action === "confirm") return askForConfirmation(check.pattern);
 * const result = await agent.run(userMessage); // only now does a model see it
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type SafetyLocale = "en" | "de" | "both";

export interface SafetyGateOptions {
  /** Hard refusals. Provided list REPLACES the locale defaults. */
  denyPatterns?: RegExp[];
  /** Require explicit confirmation. Provided list REPLACES the locale defaults. */
  confirmPatterns?: RegExp[];
  /** Which built-in pattern sets to use when a list is not provided
   *  (default "both"). */
  locale?: SafetyLocale;
}

export type SafetyCheckResult =
  | { action: "allow" }
  | { action: "deny"; pattern: string }
  | { action: "confirm"; pattern: string };

// ─── Default patterns ────────────────────────────────────────────────────────
//
// Deny: irreversible bulk destruction. Confirm: reversible-but-embarrassing
// bulk fan-out (a mass send can be legitimate; mass deletion via chat is not).
// German patterns accept both umlaut and ASCII transliteration (lösche /
// loesche) because chat input arrives in both spellings.

const EN_DENY: RegExp[] = [
  /\b(delete|remove|erase|wipe|purge)\s+(all|every(thing|one)?)\b/i,
  /\bmass[\s-]?delete\b/i,
  /\bdrop\s+(the\s+)?(table|database|db|schema)\b/i,
  /\btruncate\b[^.!?\n]*\b(table|database|db|log)s?\b/i,
];

const EN_CONFIRM: RegExp[] = [
  /\bsend\s+(it\s+|this\s+|that\s+)?to\s+(all|every(one|body))\b/i,
  /\b(email|message|notify)\s+(all|every(one|body))\b/i,
];

const DE_DENY: RegExp[] = [
  /\bl(ö|oe)sche?\s+alle[sn]?\b/i,
  /\balle[sn]?\s+l(ö|oe)schen\b/i,
  /\b(entferne|bereinige)\s+alle[sn]?\b/i,
];

const DE_CONFIRM: RegExp[] = [
  /\ban\s+alle\s+(senden|schicken|verschicken)\b/i,
  /\balle[n]?\s+(eine\s+)?(nachricht|e-?mail)\s+(senden|schicken)\b/i,
];

function defaultsFor(locale: SafetyLocale): { deny: RegExp[]; confirm: RegExp[] } {
  switch (locale) {
    case "en":
      return { deny: EN_DENY, confirm: EN_CONFIRM };
    case "de":
      return { deny: DE_DENY, confirm: DE_CONFIRM };
    case "both":
      return { deny: [...EN_DENY, ...DE_DENY], confirm: [...EN_CONFIRM, ...DE_CONFIRM] };
  }
}

// ─── Gate ────────────────────────────────────────────────────────────────────

export class SafetyGate {
  private readonly denyPatterns: RegExp[];
  private readonly confirmPatterns: RegExp[];

  constructor(opts: SafetyGateOptions = {}) {
    const defaults = defaultsFor(opts.locale ?? "both");
    this.denyPatterns = opts.denyPatterns ?? defaults.deny;
    this.confirmPatterns = opts.confirmPatterns ?? defaults.confirm;
  }

  /**
   * Screen a raw user message. Deny beats confirm (a message matching both is
   * refused). Returns the source of the matched pattern so refusals and
   * confirmation prompts can say *why*. Never throws.
   */
  check(message: string): SafetyCheckResult {
    for (const pattern of this.denyPatterns) {
      if (pattern.test(message)) return { action: "deny", pattern: pattern.source };
    }
    for (const pattern of this.confirmPatterns) {
      if (pattern.test(message)) return { action: "confirm", pattern: pattern.source };
    }
    return { action: "allow" };
  }
}

/**
 * Convenience pre-flight for integrators: run the gate against a message and
 * get the decision back. Named as an assertion of intent — "assert this is
 * allowed before any model sees it" — but it returns the check rather than
 * throwing, so callers choose their own refusal/confirmation UX.
 */
export function assertAllowed(gate: SafetyGate, message: string): SafetyCheckResult {
  return gate.check(message);
}

import { describe, it, expect } from "vitest";
import { SafetyGate, assertAllowed } from "../../src/index.js";

describe("SafetyGate defaults (locale: both)", () => {
  const gate = new SafetyGate();

  it("denies mass-delete phrasing", () => {
    expect(gate.check("please delete all customers").action).toBe("deny");
    expect(gate.check("Remove everything from the CRM").action).toBe("deny");
    expect(gate.check("do a mass delete of old leads").action).toBe("deny");
  });

  it("denies drop table/database and truncate", () => {
    expect(gate.check("DROP TABLE users").action).toBe("deny");
    expect(gate.check("can you drop the database?").action).toBe("deny");
    expect(gate.check("truncate the audit log table").action).toBe("deny");
  });

  it("requires confirmation for send-to-all", () => {
    const r = gate.check("send this to everyone on the list");
    expect(r.action).toBe("confirm");
    expect(gate.check("email all customers about the outage").action).toBe("confirm");
  });

  it("reports which pattern matched", () => {
    const r = gate.check("drop table users");
    expect(r.action).toBe("deny");
    if (r.action === "deny") expect(r.pattern).toContain("drop");
  });

  it("allows benign messages", () => {
    expect(gate.check("delete the draft for customer 42").action).toBe("allow");
    expect(gate.check("send the invoice to Maria").action).toBe("allow");
    expect(gate.check("what's on my calendar today?").action).toBe("allow");
  });

  it("denies German mass-delete (umlaut and ASCII spelling)", () => {
    expect(gate.check("lösche alle Kontakte").action).toBe("deny");
    expect(gate.check("bitte loesche alle Rechnungen").action).toBe("deny");
    expect(gate.check("alle löschen").action).toBe("deny");
  });

  it("requires confirmation for German send-to-all", () => {
    expect(gate.check("das bitte an alle senden").action).toBe("confirm");
    expect(gate.check("an alle schicken").action).toBe("confirm");
  });
});

describe("SafetyGate locale selection", () => {
  it("locale 'en' does not match German phrases", () => {
    const gate = new SafetyGate({ locale: "en" });
    expect(gate.check("lösche alle Kontakte").action).toBe("allow");
    expect(gate.check("delete all contacts").action).toBe("deny");
  });

  it("locale 'de' does not match English phrases", () => {
    const gate = new SafetyGate({ locale: "de" });
    expect(gate.check("delete all contacts").action).toBe("allow");
    expect(gate.check("lösche alle Kontakte").action).toBe("deny");
  });
});

describe("SafetyGate customization and precedence", () => {
  it("custom patterns replace the defaults for that list", () => {
    const gate = new SafetyGate({ denyPatterns: [/\bforbidden\b/i] });
    expect(gate.check("this is forbidden").action).toBe("deny");
    // default deny list replaced — but default confirm list still active
    expect(gate.check("delete all customers").action).toBe("allow");
    expect(gate.check("send this to everyone").action).toBe("confirm");
  });

  it("deny beats confirm when a message matches both", () => {
    const gate = new SafetyGate({
      denyPatterns: [/danger/i],
      confirmPatterns: [/danger/i],
    });
    expect(gate.check("danger zone").action).toBe("deny");
  });
});

describe("assertAllowed", () => {
  it("returns the gate's check result for integrator pre-flight", () => {
    const gate = new SafetyGate();
    expect(assertAllowed(gate, "hello")).toEqual({ action: "allow" });
    expect(assertAllowed(gate, "drop table users").action).toBe("deny");
  });
});

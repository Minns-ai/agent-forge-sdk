import { describe, expect, it } from "vitest";
import { scanFiles, scannable, nameForRoute, normalisePath } from "../../src/scan/scanner.js";
import { generateTool, httpToolCode, scriptToolCode } from "../../src/scan/codegen.js";

// The scanner reads what a codebase declares and turns it into tool
// candidates; the generators turn a candidate into the raw body the tool
// factory runs. Everything here is pure.

describe("paths and names", () => {
  it("normalises every framework's parameter spelling to {param}", () => {
    expect(normalisePath("/users/:id/orders/:orderId")).toEqual({ path: "/users/{id}/orders/{orderId}", params: ["id", "orderId"] });
    expect(normalisePath("/items/<int:item_id>")).toEqual({ path: "/items/{item_id}", params: ["item_id"] });
    expect(normalisePath("/pets/{petId}")).toEqual({ path: "/pets/{petId}", params: ["petId"] });
    expect(normalisePath("health")).toEqual({ path: "/health", params: [] });
  });
  it("names a route so it reads as what it does", () => {
    expect(nameForRoute("GET", "/users/{id}/orders")).toBe("get_users_by_id_orders");
    expect(nameForRoute("POST", "/")).toBe("post_root");
    expect(nameForRoute("DELETE", "/api/v1/things-here")).toBe("delete_api_v1_things_here");
  });
  it("skips build output and dependencies", () => {
    expect(scannable("src/app.ts")).toBe(true);
    expect(scannable("node_modules/x/index.js")).toBe(false);
    expect(scannable("dist/app.js")).toBe(false);
    expect(scannable("Makefile")).toBe(true);
    expect(scannable("README.md")).toBe(false);
  });
});

describe("scanFiles", () => {
  const files = [
    {
      path: "src/server.ts",
      content: `import express from "express";\nconst app = express();\n// list users\napp.get("/users", list);\napp.get("/users/:id", one);\napp.post("/users", create);\nrouter.delete("/users/:id", remove);\napp.get("/static/*", serve);\n`,
    },
    { path: "api/main.py", content: `@app.get("/items/{item_id}")\nasync def read(item_id: int): ...\n@bp.route("/legacy", methods=["POST", "PUT"])\ndef legacy(): ...\n` },
    {
      path: "openapi.json",
      content: JSON.stringify({ paths: { "/users": { get: { operationId: "listUsers", summary: "List every user" } }, "/pets/{petId}": { get: { summary: "One pet" }, put: {} } } }),
    },
    { path: "package.json", content: JSON.stringify({ scripts: { test: "vitest run", build: "tsc", prebuild: "rimraf dist" } }) },
    { path: "Makefile", content: `.PHONY: build\nbuild:\n\tgo build ./...\ntest: build\n\tgo test ./...\nVAR:=1\n` },
    { path: "node_modules/dep/routes.js", content: `app.get("/should-not-appear", x)` },
  ];
  const found = scanFiles(files);
  const names = found.map((t) => t.name);

  it("finds routes in JavaScript and Python, deduplicating what the spec also declares", () => {
    expect(names).toContain("get_users_by_id");
    expect(names).toContain("post_users");
    expect(names).toContain("delete_users_by_id");
    expect(names).toContain("get_items_by_item_id");
    expect(names).toContain("post_legacy");
    expect(names).toContain("put_legacy");
    // GET /users appears in the code and in the spec: once, the first seen.
    expect(found.filter((t) => t.http?.path === "/users" && t.http.method === "GET")).toHaveLength(1);
    expect(names).not.toContain("get_static");
    expect(names).not.toContain("get_should_not_appear");
  });

  it("takes names and summaries from an OpenAPI document", () => {
    const pet = found.find((t) => t.http?.path === "/pets/{petId}" && t.http.method === "GET")!;
    expect(pet.description).toBe("One pet");
    expect(pet.schema).toEqual({
      type: "object",
      properties: { petId: { type: "string", description: "path parameter petId" }, query: expect.any(Object) },
      required: ["petId"],
    });
    expect(found.find((t) => t.http?.method === "PUT" && t.http.path === "/pets/{petId}")!.schema).toHaveProperty("properties.body");
  });

  it("finds the commands a project already runs, not their hooks", () => {
    expect(found.find((t) => t.name === "npm_run_test")?.script).toEqual({ command: "npm run test" });
    expect(names).not.toContain("npm_run_prebuild");
    expect(found.find((t) => t.name === "make_build")?.script).toEqual({ command: "make build" });
    expect(found.find((t) => t.name === "make_test")?.line).toBe(4);
    expect(names).not.toContain("make_var");
  });

  it("records where each came from", () => {
    const one = found.find((t) => t.name === "get_users_by_id")!;
    expect(one.file).toBe("src/server.ts");
    expect(one.line).toBe(5);
  });
});

describe("generateTool", () => {
  const route = scanFiles([{ path: "s.ts", content: `app.post("/orders/:id/ship", f)` }])[0];
  const script = scanFiles([{ path: "package.json", content: JSON.stringify({ scripts: { lint: "eslint ." } }) }])[0];

  it("an HTTP tool carries the base URL as a secret and may reach only that host", () => {
    const g = generateTool(route, { http: { baseUrl: "https://api.example.com/", apiKey: "k1" } });
    expect(g.secrets).toEqual({ BASE_URL: "https://api.example.com", API_KEY: "k1" });
    expect(g.egressHosts).toEqual(["api.example.com"]);
    expect(g.code).toContain('"/orders/{id}/ship"');
    expect(g.code).toContain('method: "POST"');
    expect(g.code).toContain("body: JSON.stringify(input.body");
    expect(httpToolCode({ ...route, http: { ...route.http!, method: "GET" } })).not.toContain("body:");
  });

  it("a script tool runs in the workspace through the gateway with the box's credential", () => {
    const g = generateTool(script, { workspace: { url: "https://minns.ai/v1/sandboxes/sbx_1", token: "wk", timeoutMs: 60_000 } });
    expect(g.secrets).toEqual({ MINNS_SANDBOX_URL: "https://minns.ai/v1/sandboxes/sbx_1", MINNS_SANDBOX_TOKEN: "wk" });
    expect(g.egressHosts).toEqual(["minns.ai"]);
    expect(g.code).toContain('"npm run lint"');
    expect(g.code).toContain("/exec");
    expect(g.timeoutMs).toBe(75_000);
    expect(scriptToolCode(script, 1000)).toContain("timeoutMs: 1000");
  });

  it("refuses a candidate with no target, naming the flag", () => {
    expect(() => generateTool(route, {})).toThrow(/--base-url/);
    expect(() => generateTool(script, {})).toThrow(/--workspace/);
  });

  it("generated code never carries the secret values themselves", () => {
    const g = generateTool(route, { http: { baseUrl: "https://api.example.com", apiKey: "sk_live_123" } });
    expect(g.code).not.toContain("sk_live_123");
    expect(g.code).not.toContain("api.example.com");
  });
});

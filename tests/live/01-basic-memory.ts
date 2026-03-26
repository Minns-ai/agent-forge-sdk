/**
 * Live test: Basic MinnsMemory — ingest, hybrid search recall, NLQ answer
 */
import { createClient } from "minns-sdk";
import { MinnsMemory } from "../../dist/index.js";

const client = createClient(process.env.MINNS_API!);
const memory = new MinnsMemory({ client });

console.log("=== Test 1: Basic MinnsMemory ===\n");

// 1. Ingest some facts
console.log("Ingesting facts...");
await memory.ingest("user", "Alice is the lead engineer on the payments team. She works from London.", { caseId: "test-live-01" });
await memory.ingest("user", "Bob is a frontend developer who specializes in React and TypeScript.", { caseId: "test-live-01" });
await memory.ingest("user", "The payments service uses PostgreSQL and processes about 10,000 transactions per day.", { caseId: "test-live-01" });
console.log("OK: 3 messages ingested");

// Wait for compaction
console.log("Waiting 5s for graph ingestion + compaction...");
await new Promise((r) => setTimeout(r, 5000));

// 2. Test hybrid search recall
console.log("\n--- Hybrid Search Recall ---");
const results = await memory.recall("Who works on payments?");
console.log(`Found ${results.length} results:`);
for (const r of results.slice(0, 5)) {
  console.log(`  [${r.score.toFixed(3)}] ${r.content.slice(0, 120)}`);
}
console.log(results.length > 0 ? "OK: hybrid recall returned results" : "WARN: no results (may need more time for indexing)");

// 3. Test NLQ answer
console.log("\n--- NLQ Answer ---");
const answer = await memory.answer!("Who is Alice?");
console.log(`Answer: ${answer ?? "(no answer)"}`);
console.log(answer ? "OK: NLQ answered" : "WARN: no NLQ answer");

// 4. Test bulk ingestion
console.log("\n--- Bulk Ingestion ---");
const bulkResult = await memory.ingestBulk({
  caseId: "test-live-bulk",
  sessions: [
    {
      sessionId: "session-bulk-01",
      topic: "Sprint planning",
      messages: [
        { role: "user", content: "The auth refactor is priority one this sprint" },
        { role: "user", content: "Charlie is handling the OAuth2 integration" },
      ],
    },
    {
      sessionId: "session-bulk-02",
      topic: "Tech debt",
      messages: [
        { role: "user", content: "We need to migrate the legacy API endpoints by end of quarter" },
      ],
    },
  ],
  includeAssistantFacts: false,
});
console.log(`Bulk ingest: ${bulkResult?.messagesProcessed ?? 0} messages processed, ${bulkResult?.eventsSubmitted ?? 0} events submitted`);
console.log(bulkResult ? "OK: bulk ingestion succeeded" : "FAIL: bulk ingestion returned null");

await client.destroy();
console.log("\n=== Test 1 COMPLETE ===");

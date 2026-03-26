/**
 * Debug: test ingestConversations directly
 */
import { createClient } from "minns-sdk";

const client = createClient(process.env.MINNS_API!);

// Exact same shape as the SDK example in the docs
console.log("--- Test: ingestConversations (SDK example) ---");
try {
  const result = await client.ingestConversations({
    case_id: "test-debug-ingest",
    sessions: [
      {
        session_id: "session_01",
        topic: "Test topic",
        messages: [
          { role: "user", content: "Alice paid 50 for lunch split with Bob" },
          { role: "user", content: "Bob paid 30 for coffee" },
        ],
      },
    ],
  });
  console.log("OK:", JSON.stringify(result, null, 2));
} catch (err: any) {
  console.log("ERR:", err.message?.slice(0, 200), "status:", err.statusCode);
}

await client.destroy();

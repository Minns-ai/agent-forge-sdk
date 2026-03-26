/**
 * Live test: Temporal tables, MinnsQL, reactive subscriptions
 */
import { createClient } from "minns-sdk";

const client = createClient(process.env.MINNS_API!);

console.log("=== Test 2: Tables + MinnsQL + Subscriptions ===\n");

// 1. Create a table
console.log("--- Create Table ---");
try {
  const table = await client.createTable({
    name: "test_tasks",
    columns: [
      { name: "id", col_type: "Int64", primary_key: true, nullable: false },
      { name: "title", col_type: "String", nullable: false },
      { name: "assignee", col_type: "String", nullable: true },
      { name: "status", col_type: "String", nullable: true },
      { name: "points", col_type: "Int64", nullable: true },
    ],
  });
  console.log("OK: table created", JSON.stringify(table));
} catch (err: any) {
  if (err.message?.includes("already exists")) {
    console.log("OK: table already exists, continuing...");
  } else {
    console.log("ERR:", err.message, err.statusCode);
  }
}

// 2. Insert rows
console.log("\n--- Insert Rows ---");
try {
  const r1 = await client.insertRows("test_tasks", { values: [1, "Auth refactor", "Alice", "in_progress", 5] });
  console.log("Row 1:", JSON.stringify(r1));
  const r2 = await client.insertRows("test_tasks", { values: [2, "API gateway", "Bob", "blocked", 8] });
  console.log("Row 2:", JSON.stringify(r2));
  const r3 = await client.insertRows("test_tasks", { values: [3, "Dashboard UI", "Charlie", "done", 3] });
  console.log("Row 3:", JSON.stringify(r3));
  console.log("OK: 3 rows inserted");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

// 3. Scan rows
console.log("\n--- Scan Rows (active) ---");
try {
  const scan = await client.scanRows("test_tasks");
  console.log(`Active rows: ${scan.count}`);
  for (const row of scan.rows) {
    console.log(`  row_id=${row.row_id} values=${JSON.stringify(row.values)}`);
  }
  console.log("OK: scan succeeded");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

// 4. Update a row
console.log("\n--- Update Row ---");
try {
  const upd = await client.updateRow("test_tasks", 2, { values: [2, "API gateway", "Bob", "in_progress", 8] });
  console.log("Update result:", JSON.stringify(upd));
  console.log("OK: row updated (new version created)");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

// 5. Scan with all versions
console.log("\n--- Scan Rows (all versions) ---");
try {
  const scanAll = await client.scanRows("test_tasks", { when: "all" });
  console.log(`All versions: ${scanAll.count} rows`);
  for (const row of scanAll.rows) {
    console.log(`  row_id=${row.row_id} v=${row.version_id} valid_from=${row.valid_from} valid_until=${row.valid_until ?? "active"} values=${JSON.stringify(row.values)}`);
  }
  console.log("OK: historical scan succeeded");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

// 6. MinnsQL query
console.log("\n--- MinnsQL Query ---");
try {
  const q = await client.executeQuery('FROM test_tasks WHERE test_tasks.status = "in_progress" RETURN test_tasks.title, test_tasks.assignee');
  console.log(`Columns: ${q.columns.join(", ")}`);
  console.log(`Rows: ${q.rows.length}`);
  for (const row of q.rows) {
    console.log(`  ${JSON.stringify(row)}`);
  }
  console.log(`Stats: ${JSON.stringify(q.stats)}`);
  console.log("OK: MinnsQL query succeeded");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

// 7. MinnsQL aggregation
console.log("\n--- MinnsQL Aggregation ---");
try {
  const agg = await client.executeQuery('FROM test_tasks GROUP BY test_tasks.status RETURN test_tasks.status, count(*) AS cnt, sum(test_tasks.points) AS total');
  console.log(`Columns: ${agg.columns.join(", ")}`);
  for (const row of agg.rows) {
    console.log(`  ${JSON.stringify(row)}`);
  }
  console.log("OK: MinnsQL aggregation succeeded");
} catch (err: any) {
  console.log("ERR:", err.message?.slice(0, 300), err.statusCode);
}

// 7b. MinnsQL simple count
console.log("\n--- MinnsQL Count ---");
try {
  const cnt = await client.executeQuery('FROM test_tasks RETURN count(*)');
  console.log(`Count result: ${JSON.stringify(cnt.rows)}`);
  console.log("OK: MinnsQL count succeeded");
} catch (err: any) {
  console.log("ERR:", err.message?.slice(0, 300), err.statusCode);
}

// 8. Reactive subscription
console.log("\n--- Reactive Subscription ---");
try {
  const sub = await client.createSubscription('FROM test_tasks WHERE test_tasks.status = "blocked" RETURN test_tasks.title, test_tasks.assignee');
  console.log(`Subscription ID: ${sub.subscription_id}`);
  console.log(`Strategy: ${sub.strategy}`);
  console.log(`Initial results: ${sub.initial.rows.length} rows`);
  for (const row of sub.initial.rows) {
    console.log(`  ${JSON.stringify(row)}`);
  }

  // Insert a new blocked task
  await client.insertRows("test_tasks", { values: [4, "Logging overhaul", "Diana", "blocked", 5] });
  console.log("Inserted new blocked task...");

  // Poll for changes
  await new Promise((r) => setTimeout(r, 500));
  const poll = await client.pollSubscription(sub.subscription_id);
  const inserts = poll.updates.flatMap((u) => u.inserts);
  const deletes = poll.updates.flatMap((u) => u.deletes);
  console.log(`Poll: ${inserts.length} inserts, ${deletes.length} deletes`);
  for (const ins of inserts) {
    console.log(`  INSERT: ${JSON.stringify(ins)}`);
  }

  // Clean up subscription
  await client.deleteSubscription(sub.subscription_id);
  console.log("OK: subscription created, polled, deleted");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

// 9. Table stats
console.log("\n--- Table Stats ---");
try {
  const stats = await client.getTableStats("test_tasks");
  console.log(JSON.stringify(stats));
  console.log("OK: stats retrieved");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

// 10. Soft delete
console.log("\n--- Soft Delete ---");
try {
  const del = await client.deleteRow("test_tasks", 3);
  console.log("Delete result:", JSON.stringify(del));
  const afterDel = await client.scanRows("test_tasks");
  console.log(`Active rows after delete: ${afterDel.count}`);
  console.log("OK: soft delete succeeded");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

// Cleanup: drop table
console.log("\n--- Cleanup ---");
try {
  await client.dropTable("test_tasks");
  console.log("OK: table dropped");
} catch (err: any) {
  console.log("ERR:", err.message, err.statusCode);
}

await client.destroy();
console.log("\n=== Test 2 COMPLETE ===");

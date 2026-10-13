// Postgres schema migrations are additive and idempotent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresStore } from "./store.ts";

const database = process.env.TEST_DATABASE_URL;

test(
  "Postgres: conversations carry a nullable, unused project_id (idempotent migration)",
  { skip: !database && "TEST_DATABASE_URL not set" },
  async () => {
    // Opening twice runs the migration twice.
    for (let i = 0; i < 2; i++)
      await (await PostgresStore.open(database!, { listen: false })).close();
    const client = new Client({ connectionString: database });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_name = 'prototype_conversations' AND column_name = 'project_id'`,
      );
      assert.deepEqual(rows, [{ data_type: "text", is_nullable: "YES" }]);
    } finally {
      await client.end();
    }
  },
);

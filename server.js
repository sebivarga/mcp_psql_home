import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import pg from "pg";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

// ─── Database Pool ────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err.message);
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "pg-mcp-server",
  version: "1.0.0",
});

// ── Tool: execute_query (arbitrary SQL) ──────────────────────────────────────
server.tool(
  "execute_query",
  "Execute any SQL query against the PostgreSQL database. Supports SELECT, INSERT, UPDATE, DELETE, DDL, etc.",
  {
    sql: z.string().describe("The SQL query to execute"),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Optional parameterized query values ($1, $2, ...)"),
  },
  async ({ sql, params = [] }) => {
    try {
      const result = await query(sql, params);
      const text = JSON.stringify(
        {
          rowCount: result.rowCount,
          fields: result.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
          rows: result.rows,
        },
        null,
        2
      );
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: list_tables ─────────────────────────────────────────────────────────
server.tool(
  "list_tables",
  "List all tables in a schema (default: public). Returns table names, row estimates, and sizes.",
  {
    schema: z.string().optional().default("public").describe("Schema name (default: public)"),
  },
  async ({ schema }) => {
    try {
      const result = await query(
        `SELECT
           t.table_name,
           t.table_type,
           pg_size_pretty(pg_total_relation_size(quote_ident(t.table_schema)||'.'||quote_ident(t.table_name))) AS total_size,
           COALESCE(s.n_live_tup, 0) AS estimated_rows
         FROM information_schema.tables t
         LEFT JOIN pg_stat_user_tables s
           ON s.schemaname = t.table_schema AND s.relname = t.table_name
         WHERE t.table_schema = $1
         ORDER BY t.table_name`,
        [schema]
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: describe_table ──────────────────────────────────────────────────────
server.tool(
  "describe_table",
  "Describe a table: columns, types, nullability, defaults, indexes, and foreign keys.",
  {
    table: z.string().describe("Table name"),
    schema: z.string().optional().default("public").describe("Schema name (default: public)"),
  },
  async ({ table, schema }) => {
    try {
      const [columns, indexes, fkeys] = await Promise.all([
        query(
          `SELECT column_name, data_type, character_maximum_length, is_nullable,
                  column_default, ordinal_position
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schema, table]
        ),
        query(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = $1 AND tablename = $2`,
          [schema, table]
        ),
        query(
          `SELECT
             kcu.column_name,
             ccu.table_name AS foreign_table,
             ccu.column_name AS foreign_column,
             rc.update_rule,
             rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = rc.unique_constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_schema = $1 AND tc.table_name = $2`,
          [schema, table]
        ),
      ]);

      const text = JSON.stringify(
        { columns: columns.rows, indexes: indexes.rows, foreignKeys: fkeys.rows },
        null,
        2
      );
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: list_schemas ────────────────────────────────────────────────────────
server.tool(
  "list_schemas",
  "List all schemas in the database.",
  {},
  async () => {
    try {
      const result = await query(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
         ORDER BY schema_name`
      );
      return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool: get_db_stats ────────────────────────────────────────────────────────
server.tool(
  "get_db_stats",
  "Get database statistics: size, active connections, cache hit ratio, top tables by size.",
  {},
  async () => {
    try {
      const [dbSize, connections, cacheHit, topTables] = await Promise.all([
        query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
                      current_database() AS database_name`),
        query(`SELECT count(*) AS total,
                      count(*) FILTER (WHERE state = 'active') AS active,
                      count(*) FILTER (WHERE state = 'idle') AS idle
               FROM pg_stat_activity WHERE datname = current_database()`),
        query(`SELECT round(
                 sum(heap_blks_hit) * 100.0 / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2
               ) AS cache_hit_ratio FROM pg_statio_user_tables`),
        query(`SELECT relname AS table_name,
                      pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
                      n_live_tup AS live_rows
               FROM pg_stat_user_tables
               ORDER BY pg_total_relation_size(relid) DESC LIMIT 10`),
      ]);

      const text = JSON.stringify(
        {
          database: dbSize.rows[0],
          connections: connections.rows[0],
          cacheHitRatio: cacheHit.rows[0],
          topTablesBySize: topTables.rows,
        },
        null,
        2
      );
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Express + SSE Transport ──────────────────────────────────────────────────
const app = express();
app.use(express.json());

const transports = new Map();

app.get("/sse", async (req, res) => {
  console.log(`[SSE] New connection from ${req.ip}`);
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    console.log(`[SSE] Connection closed: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok", database: "connected", sessions: transports.size });
  } catch (err) {
    res.status(503).json({ status: "error", database: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ PG MCP Server running on port ${PORT}`);
  console.log(`   SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});

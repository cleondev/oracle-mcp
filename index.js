#!/usr/bin/env node
// Read-only MCP server for Oracle, using the official node-oracledb driver in thin mode
// (no Instant Client needed).
//
// Credentials, one of:
//   ORACLE_APPSETTINGS = path to a .NET appsettings*.json file + ORACLE_CONN_NAME (default
//                        "DefaultConnection"). The .NET connection string
//                        "User Id=..;Password=..;Data Source=host:port/service" is read at
//                        startup, so the password never has to be copied into the MCP config.
//   ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECT_STRING (host:port/service)
//
// Guardrails: only SELECT / WITH statements; each runs inside SET TRANSACTION READ ONLY and is
// rolled back; one statement per call; row cap.
import fs from "node:fs";
import oracledb from "oracledb";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ORACLE_ALLOW_WRITE=true enables the `execute` and `transaction` tools (DML/DDL, committed).
// `query` stays read-only either way.
const ALLOW_WRITE = /^(1|true|yes)$/i.test(process.env.ORACLE_ALLOW_WRITE ?? "");
const MAX_ROWS_DEFAULT = 200;
const MAX_ROWS_LIMIT = 2000;

function parseDotNetConnString(cs) {
  const parts = {};
  for (const seg of cs.split(";")) {
    const i = seg.indexOf("=");
    if (i <= 0) continue;
    parts[seg.slice(0, i).trim().toLowerCase().replace(/\s+/g, "")] = seg.slice(i + 1).trim();
  }
  return {
    user: parts["userid"] ?? parts["user"] ?? parts["uid"],
    password: parts["password"] ?? parts["pwd"],
    connectString: parts["datasource"] ?? parts["server"],
  };
}

function loadConfig() {
  if (process.env.ORACLE_APPSETTINGS) {
    const name = process.env.ORACLE_CONN_NAME || "DefaultConnection";
    const text = fs.readFileSync(process.env.ORACLE_APPSETTINGS, "utf8");
    // appsettings may contain comments (JSONC), so pick the value with a regex instead of JSON.parse.
    const m = text.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) throw new Error(`Connection string "${name}" not found in ${process.env.ORACLE_APPSETTINGS}`);
    return parseDotNetConnString(JSON.parse(`"${m[1]}"`));
  }
  return {
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
  };
}

const cfg = loadConfig();
if (!cfg.user || !cfg.password || !cfg.connectString) {
  console.error("oracle-mcp: missing user/password/connectString");
  process.exit(1);
}

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB, oracledb.DATE, oracledb.NUMBER];

let pool;
async function getPool() {
  if (!pool) {
    pool = await oracledb.createPool({
      user: cfg.user,
      password: cfg.password,
      connectString: cfg.connectString,
      poolMin: 0,
      poolMax: 4,
      poolTimeout: 60,
    });
  }
  return pool;
}

function assertReadOnly(sql) {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (stripped.includes(";")) throw new Error("Only one statement per call.");
  if (!/^(select|with)\b/i.test(stripped)) throw new Error("Read-only server: only SELECT / WITH statements are allowed.");
  if (/\bfor\s+update\b/i.test(stripped)) throw new Error("SELECT ... FOR UPDATE is not allowed.");
  return stripped;
}

async function runReadOnly(sql, binds = {}, maxRows = MAX_ROWS_DEFAULT) {
  const conn = await (await getPool()).getConnection();
  try {
    await conn.execute("SET TRANSACTION READ ONLY");
    const res = await conn.execute(sql, binds, { maxRows: Math.min(Math.max(1, maxRows), MAX_ROWS_LIMIT) });
    return { rowCount: res.rows?.length ?? 0, rows: res.rows ?? [] };
  } finally {
    try { await conn.rollback(); } catch { /* ignore */ }
    await conn.close();
  }
}

function stripOne(sql) {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
  // PL/SQL blocks keep their semicolons; plain SQL drops one trailing ';'
  if (/^(begin|declare)\b/i.test(s)) return sql.trim();
  const t = s.replace(/;\s*$/, "");
  if (t.includes(";")) throw new Error("Only one statement per call (use `transaction` for several).");
  return t;
}

async function runWrite(statements) {
  const conn = await (await getPool()).getConnection();
  try {
    const results = [];
    for (const st of statements) {
      const res = await conn.execute(stripOne(String(st.sql ?? "")), st.binds ?? {}, { autoCommit: false });
      results.push({ rowsAffected: res.rowsAffected ?? null });
    }
    await conn.commit();
    return { committed: true, results };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw new Error(`${err.message} (rolled back)`);
  } finally {
    await conn.close();
  }
}

const WRITE_TOOLS = [
  {
    name: "execute",
    description: "Run ONE write statement (INSERT/UPDATE/DELETE/MERGE/DDL or a PL/SQL BEGIN..END block) and COMMIT. Rolled back on error. Use :name binds.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        binds: { type: "object" },
      },
      required: ["sql"],
    },
  },
  {
    name: "transaction",
    description: "Run several write statements in one transaction: all COMMIT together, or all ROLLBACK if any fails.",
    inputSchema: {
      type: "object",
      properties: {
        statements: {
          type: "array",
          items: { type: "object", properties: { sql: { type: "string" }, binds: { type: "object" } }, required: ["sql"] },
        },
      },
      required: ["statements"],
    },
  },
];

const TOOLS = [
  {
    name: "query",
    description: "Run one read-only SQL statement (SELECT / WITH) and return rows as JSON objects. Use :name bind variables with the binds object.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SELECT or WITH statement, no trailing semicolon needed" },
        binds: { type: "object", description: "Bind values, e.g. {\"code\": \"INPUT.USER1\"} for :code" },
        maxRows: { type: "number", description: `Row cap (default ${MAX_ROWS_DEFAULT}, max ${MAX_ROWS_LIMIT})` },
      },
      required: ["sql"],
    },
  },
  {
    name: "list_tables",
    description: "List tables visible to the connected user, optionally filtered by owner and a LIKE pattern on the table name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Schema owner (default: current user)" },
        pattern: { type: "string", description: "LIKE pattern on table name, e.g. SYS_%" },
      },
    },
  },
  {
    name: "describe_table",
    description: "Columns of a table: name, data type, length, nullable.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        owner: { type: "string", description: "Schema owner (default: current user)" },
      },
      required: ["table"],
    },
  },
  {
    name: "connection_info",
    description: "Show the connected database user, service and server time (no secrets).",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server({ name: "oracle-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALLOW_WRITE ? [...TOOLS, ...WRITE_TOOLS] : TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    if (name === "query") {
      result = await runReadOnly(assertReadOnly(String(args.sql ?? "")), args.binds ?? {}, Number(args.maxRows ?? MAX_ROWS_DEFAULT));
    } else if (name === "list_tables") {
      const owner = args.owner ? String(args.owner).toUpperCase() : null;
      result = await runReadOnly(
        `SELECT owner, table_name FROM all_tables
         WHERE owner = NVL(:owner, USER) AND table_name LIKE NVL(:pattern, '%')
         ORDER BY table_name`,
        { owner, pattern: args.pattern ? String(args.pattern).toUpperCase() : null },
        MAX_ROWS_LIMIT,
      );
    } else if (name === "describe_table") {
      result = await runReadOnly(
        `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable
         FROM all_tab_columns
         WHERE owner = NVL(:owner, USER) AND table_name = :tbl
         ORDER BY column_id`,
        { owner: args.owner ? String(args.owner).toUpperCase() : null, tbl: String(args.table).toUpperCase() },
        MAX_ROWS_LIMIT,
      );
    } else if (name === "connection_info") {
      result = await runReadOnly(
        `SELECT USER AS db_user, SYS_CONTEXT('USERENV','SERVICE_NAME') AS service, SYS_CONTEXT('USERENV','DB_NAME') AS db_name, TO_CHAR(SYSTIMESTAMP,'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS server_time FROM dual`,
      );
    } else if (ALLOW_WRITE && name === "execute") {
      result = await runWrite([{ sql: args.sql, binds: args.binds }]);
    } else if (ALLOW_WRITE && name === "transaction") {
      if (!Array.isArray(args.statements) || args.statements.length === 0) throw new Error("statements must be a non-empty array");
      result = await runWrite(args.statements);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
});

await server.connect(new StdioServerTransport());

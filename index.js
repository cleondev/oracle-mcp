#!/usr/bin/env node
// MCP server for Oracle Database (one server, many named connections), built on the official
// node-oracledb driver in thin mode (no Instant Client needed).
//
// Connections come from a JSON file (ORACLE_CONNECTIONS_FILE, default ./connections.json next to
// this script). Each entry gives credentials one of two ways:
//   { "appsettings": "C:/repo/Api/appsettings.Development.json", "connName": "DefaultConnection" }
//       -> reads the .NET connection string "User Id=..;Password=..;Data Source=host:port/service"
//          at connect time, so the password stays where it already lives.
//   { "user": "APP", "password": "...", "connectString": "host:1521/SERVICE" }
// plus optional "allowWrite": true (enables execute/transaction for that connection) and
// "description".
// If the file is missing, a single connection named "default" is built from the legacy env vars
// (ORACLE_APPSETTINGS + ORACLE_CONN_NAME, or ORACLE_USER/ORACLE_PASSWORD/ORACLE_CONNECT_STRING,
// ORACLE_ALLOW_WRITE).
//
// Guardrails: `query` only runs SELECT / WITH inside SET TRANSACTION READ ONLY and rolls back;
// write tools are refused for connections without allowWrite; one statement per call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import oracledb from "oracledb";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECTIONS_FILE = process.env.ORACLE_CONNECTIONS_FILE || path.join(HERE, "connections.json");
const MAX_ROWS_DEFAULT = 200;
const MAX_ROWS_LIMIT = 2000;
const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? ""));

// ---------- configuration ----------
function loadConnections() {
  if (fs.existsSync(CONNECTIONS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(CONNECTIONS_FILE, "utf8"));
    const map = raw.connections ?? raw;
    if (!map || typeof map !== "object" || Object.keys(map).length === 0)
      throw new Error(`No connections defined in ${CONNECTIONS_FILE}`);
    return { connections: map, defaultName: raw.default ?? Object.keys(map)[0] };
  }
  const legacy = {
    appsettings: process.env.ORACLE_APPSETTINGS,
    connName: process.env.ORACLE_CONN_NAME,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING,
    allowWrite: truthy(process.env.ORACLE_ALLOW_WRITE),
  };
  if (!legacy.appsettings && !legacy.user) throw new Error(`No ${CONNECTIONS_FILE} and no ORACLE_* env vars`);
  return { connections: { default: legacy }, defaultName: "default" };
}

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

function resolveCredentials(name, c) {
  if (c.appsettings) {
    const key = c.connName || "DefaultConnection";
    const text = fs.readFileSync(c.appsettings, "utf8");
    // appsettings may contain comments (JSONC): pick the value with a regex instead of JSON.parse.
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) throw new Error(`[${name}] connection string "${key}" not found in ${c.appsettings}`);
    return parseDotNetConnString(JSON.parse(`"${m[1]}"`));
  }
  return { user: c.user, password: c.password, connectString: c.connectString };
}

const { connections: CONNECTIONS, defaultName: DEFAULT_CONN } = loadConnections();
const ANY_WRITE = Object.values(CONNECTIONS).some((c) => c.allowWrite);

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB, oracledb.DATE, oracledb.NUMBER];

const pools = new Map();
function pickConnection(name) {
  const key = name || DEFAULT_CONN;
  const c = CONNECTIONS[key];
  if (!c) throw new Error(`Unknown connection "${key}". Available: ${Object.keys(CONNECTIONS).join(", ")}`);
  return { key, c };
}
async function getPool(key, c) {
  if (!pools.has(key)) {
    const cred = resolveCredentials(key, c);
    if (!cred.user || !cred.password || !cred.connectString) throw new Error(`[${key}] incomplete credentials`);
    pools.set(key, oracledb.createPool({ ...cred, poolMin: 0, poolMax: 4, poolTimeout: 60 }).catch((e) => {
      pools.delete(key);
      throw e;
    }));
  }
  return pools.get(key);
}

// ---------- execution ----------
function assertReadOnly(sql) {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new Error("Only one statement per call.");
  if (!/^(select|with)\b/i.test(s)) throw new Error("`query` is read-only: only SELECT / WITH. Use `execute` for writes.");
  if (/\bfor\s+update\b/i.test(s)) throw new Error("SELECT ... FOR UPDATE is not allowed in `query`.");
  return s;
}

function stripOne(sql) {
  const s = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
  if (/^(begin|declare)\b/i.test(s)) return sql.trim(); // PL/SQL block keeps its semicolons
  const t = s.replace(/;\s*$/, "");
  if (t.includes(";")) throw new Error("Only one statement per call (use `transaction` for several).");
  return t;
}

async function runReadOnly(connName, sql, binds = {}, maxRows = MAX_ROWS_DEFAULT) {
  const { key, c } = pickConnection(connName);
  const conn = await (await getPool(key, c)).getConnection();
  try {
    await conn.execute("SET TRANSACTION READ ONLY");
    const res = await conn.execute(sql, binds, { maxRows: Math.min(Math.max(1, maxRows), MAX_ROWS_LIMIT) });
    return { connection: key, rowCount: res.rows?.length ?? 0, rows: res.rows ?? [] };
  } finally {
    try { await conn.rollback(); } catch { /* ignore */ }
    await conn.close();
  }
}

async function runWrite(connName, statements) {
  const { key, c } = pickConnection(connName);
  if (!c.allowWrite) throw new Error(`Connection "${key}" is read-only (set "allowWrite": true in ${path.basename(CONNECTIONS_FILE)} to enable writes).`);
  const conn = await (await getPool(key, c)).getConnection();
  try {
    const results = [];
    for (const st of statements) {
      const res = await conn.execute(stripOne(String(st.sql ?? "")), st.binds ?? {}, { autoCommit: false });
      results.push({ rowsAffected: res.rowsAffected ?? null });
    }
    await conn.commit();
    return { connection: key, committed: true, results };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw new Error(`[${key}] ${err.message} (rolled back)`);
  } finally {
    await conn.close();
  }
}

// ---------- tools ----------
const connProp = {
  connection: { type: "string", description: `Connection name (default "${DEFAULT_CONN}"). See list_connections.` },
};

const READ_TOOLS = [
  {
    name: "list_connections",
    description: "List configured Oracle connections: name, description, whether writes are allowed (no secrets).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query",
    description: "Run one read-only SQL statement (SELECT / WITH) and return rows as JSON objects. Use :name binds.",
    inputSchema: {
      type: "object",
      properties: {
        ...connProp,
        sql: { type: "string" },
        binds: { type: "object", description: "e.g. {\"code\": \"INPUT.USER1\"} for :code" },
        maxRows: { type: "number", description: `Row cap (default ${MAX_ROWS_DEFAULT}, max ${MAX_ROWS_LIMIT})` },
      },
      required: ["sql"],
    },
  },
  {
    name: "list_tables",
    description: "List tables of a schema (default: the connection's user), optional LIKE pattern on the name.",
    inputSchema: {
      type: "object",
      properties: { ...connProp, owner: { type: "string" }, pattern: { type: "string", description: "e.g. SYS_%" } },
    },
  },
  {
    name: "describe_table",
    description: "Columns of a table: name, data type, length, nullable.",
    inputSchema: {
      type: "object",
      properties: { ...connProp, table: { type: "string" }, owner: { type: "string" } },
      required: ["table"],
    },
  },
  {
    name: "connection_info",
    description: "Connected database user, service and server time for a connection (no secrets).",
    inputSchema: { type: "object", properties: { ...connProp } },
  },
];

const WRITE_TOOLS = [
  {
    name: "execute",
    description: "Run ONE write statement (INSERT/UPDATE/DELETE/MERGE/DDL or PL/SQL BEGIN..END) and COMMIT. Rolled back on error. Only for connections with allowWrite.",
    inputSchema: {
      type: "object",
      properties: { ...connProp, sql: { type: "string" }, binds: { type: "object" } },
      required: ["sql"],
    },
  },
  {
    name: "transaction",
    description: "Run several write statements in one transaction: all COMMIT, or all ROLLBACK if one fails. Only for connections with allowWrite.",
    inputSchema: {
      type: "object",
      properties: {
        ...connProp,
        statements: {
          type: "array",
          items: { type: "object", properties: { sql: { type: "string" }, binds: { type: "object" } }, required: ["sql"] },
        },
      },
      required: ["statements"],
    },
  },
];

const server = new Server({ name: "oracle-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ANY_WRITE ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const cn = args.connection;
  try {
    let result;
    switch (name) {
      case "list_connections":
        result = {
          default: DEFAULT_CONN,
          connections: Object.entries(CONNECTIONS).map(([k, c]) => ({
            name: k,
            description: c.description ?? null,
            allowWrite: !!c.allowWrite,
            source: c.appsettings ? `appsettings:${c.connName || "DefaultConnection"}` : "inline",
          })),
        };
        break;
      case "query":
        result = await runReadOnly(cn, assertReadOnly(String(args.sql ?? "")), args.binds ?? {}, Number(args.maxRows ?? MAX_ROWS_DEFAULT));
        break;
      case "list_tables":
        result = await runReadOnly(
          cn,
          `SELECT owner, table_name FROM all_tables
           WHERE owner = NVL(:owner, USER) AND table_name LIKE NVL(:pattern, '%') ORDER BY table_name`,
          { owner: args.owner ? String(args.owner).toUpperCase() : null, pattern: args.pattern ? String(args.pattern).toUpperCase() : null },
          MAX_ROWS_LIMIT,
        );
        break;
      case "describe_table":
        result = await runReadOnly(
          cn,
          `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable
           FROM all_tab_columns WHERE owner = NVL(:owner, USER) AND table_name = :tbl ORDER BY column_id`,
          { owner: args.owner ? String(args.owner).toUpperCase() : null, tbl: String(args.table).toUpperCase() },
          MAX_ROWS_LIMIT,
        );
        break;
      case "connection_info":
        result = await runReadOnly(
          cn,
          `SELECT USER AS db_user, SYS_CONTEXT('USERENV','SERVICE_NAME') AS service, SYS_CONTEXT('USERENV','DB_NAME') AS db_name,
                  TO_CHAR(SYSTIMESTAMP,'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS server_time FROM dual`,
        );
        break;
      case "execute":
        result = await runWrite(cn, [{ sql: args.sql, binds: args.binds }]);
        break;
      case "transaction":
        if (!Array.isArray(args.statements) || args.statements.length === 0) throw new Error("statements must be a non-empty array");
        result = await runWrite(cn, args.statements);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
});

await server.connect(new StdioServerTransport());

# oracle-mcp

Minimal MCP server for Oracle Database, built on the official [node-oracledb](https://github.com/oracle/node-oracledb) driver in **thin mode** (no Oracle Instant Client needed).

## Tools

| Tool | Mode | What it does |
|---|---|---|
| `query` | read | One `SELECT` / `WITH` statement, run inside `SET TRANSACTION READ ONLY` and rolled back. Row cap (default 200, max 2000). |
| `list_tables` | read | Tables of a schema, optional `LIKE` filter. |
| `describe_table` | read | Columns of a table. |
| `connection_info` | read | Connected user, service, DB name, server time. |
| `execute` | write* | One DML/DDL statement or PL/SQL `BEGIN..END` block, committed; rolled back on error. |
| `transaction` | write* | Several statements committed together, or all rolled back. |

\* Only exposed when `ORACLE_ALLOW_WRITE=true`.

## Configuration (environment variables)

Either point at a .NET `appsettings*.json` file, so the password stays where it already lives:

| Variable | Example |
|---|---|
| `ORACLE_APPSETTINGS` | `S:/repo/Api/appsettings.Development.json` |
| `ORACLE_CONN_NAME` | `DefaultConnection` (default) — value like `User Id=..;Password=..;Data Source=host:1521/service` |

or give the parts directly:

| Variable | Example |
|---|---|
| `ORACLE_USER` | `APP_USER` |
| `ORACLE_PASSWORD` | `***` |
| `ORACLE_CONNECT_STRING` | `db-host:1521/ORCLPDB1` |

Optional: `ORACLE_ALLOW_WRITE=true` to enable `execute` / `transaction`.

## Install

```bash
npm install
claude mcp add oracle-mydb -s user \
  -e ORACLE_APPSETTINGS=/path/to/appsettings.Development.json \
  -e ORACLE_CONN_NAME=DefaultConnection \
  -- node /path/to/oracle-mcp/index.js
```

Requires Node.js 18+.

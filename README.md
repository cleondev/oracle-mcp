# oracle-mcp

MCP server for Oracle Database: **one server, many named connections**. Built on the official [node-oracledb](https://github.com/oracle/node-oracledb) driver in **thin mode**, so the Oracle Instant Client is not needed.

## Tools

Every tool takes an optional `connection` argument. If you leave it out, the server uses `default` from the config file.

| Tool | Mode | What it does |
|---|---|---|
| `list_connections` | read | Lists the configured connections with their description and write flag. Secrets are not shown. |
| `query` | read | Runs one `SELECT` / `WITH` statement inside `SET TRANSACTION READ ONLY`, then rolls back. Row cap is 200 by default, 2000 at most. |
| `list_tables` | read | Lists the tables of a schema. Takes an optional `LIKE` filter. |
| `describe_table` | read | Lists the columns of a table. |
| `connection_info` | read | Shows the connected user, service, DB name and server time. |
| `execute` | write* | Runs one DML/DDL statement or PL/SQL `BEGIN..END` block and commits. On error it rolls back. |
| `transaction` | write* | Runs several statements and commits them together. If one fails, all of them roll back. |

\* The write tools are listed when at least one connection has `"allowWrite": true`. They are refused on connections that don't have it.

## Configuration: `connections.json`

The server reads `connections.json` next to `index.js`. To use another file, set `ORACLE_CONNECTIONS_FILE`. The file is git-ignored; `connections.example.json` is a template.

```json
{
  "default": "app-uat",
  "connections": {
    "app-uat": {
      "appsettings": "C:/repos/MyApp/Api/appsettings.Development.json",
      "connName": "DefaultConnection",
      "allowWrite": true
    },
    "app-prod-ro": {
      "user": "APP_READER", "password": "***", "connectString": "db-host:1521/ORCLPDB1"
    }
  }
}
```

- `appsettings` + `connName`: the server reads the .NET connection string (`User Id=..;Password=..;Data Source=host:port/service`) from that file when it connects. The password never leaves the file where it already lives. JSONC comments are tolerated.
- `user` / `password` / `connectString`: inline credentials.
- `allowWrite` defaults to `false`.

Legacy mode: if there is no config file, the server builds a single `default` connection from these env vars:
- `ORACLE_APPSETTINGS` + `ORACLE_CONN_NAME`, or `ORACLE_USER` / `ORACLE_PASSWORD` / `ORACLE_CONNECT_STRING`
- `ORACLE_ALLOW_WRITE`

## Install

```bash
npm install
cp connections.example.json connections.json   # then edit
claude mcp add oracle -s user -- node /path/to/oracle-mcp/index.js
```

To add a database later, edit `connections.json` and restart the session. You don't need to re-register the server.

Requires Node.js 18+.

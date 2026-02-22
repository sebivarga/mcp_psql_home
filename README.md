# PostgreSQL MCP Server

An MCP (Model Context Protocol) server that gives Claude full access to your PostgreSQL database over SSE (HTTP).

## Available Tools

| Tool | Description |
|------|-------------|
| `execute_query` | Run any SQL — SELECT, INSERT, UPDATE, DELETE, DDL |
| `list_tables` | List tables with sizes and row estimates |
| `describe_table` | Full schema of a table: columns, indexes, foreign keys |
| `list_schemas` | List all schemas in the database |
| `get_db_stats` | Database size, connections, cache hit ratio, top tables |

---

## Setup

### 1. Configure environment

```bash
cp .env.example .env
nano .env   # fill in your Postgres credentials
```

Key settings:
- `PG_HOST` — IP or hostname of your PostgreSQL server
- If Postgres runs on the **same Docker host**: use `host.docker.internal` (Linux: requires `extra_hosts` in compose) or the host's LAN IP
- If Postgres runs in **another Docker container/network**: use the container name and add the network to docker-compose.yml

### 2. Build and start

```bash
docker compose up -d --build
```

### 3. Verify it's working

```bash
curl http://localhost:3000/health
# → {"status":"ok","database":"connected","sessions":0}
```

---

## Connect Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)  
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "power-db": {
      "transport": "sse",
      "url": "http://YOUR_SERVER_IP:3000/sse"
    }
  }
}
```

Replace `YOUR_SERVER_IP` with your Docker host's IP (e.g. `192.168.1.50`).

Then restart Claude Desktop. You'll see the tools appear in Claude's tool panel.

---

## Connect Claude.ai (Remote MCP)

In Claude.ai Settings → Integrations → Add MCP Server:
- **URL**: `http://YOUR_SERVER_IP:3000/sse`

> Note: For claude.ai remote MCP, the server must be reachable from the internet or via a tunnel (e.g. `ngrok http 3000`).

---

## Networking Tips

### Postgres on Docker host (Linux)
Add to `docker-compose.yml` under the service:
```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```
Then use `PG_HOST=host.docker.internal`.

### Postgres in another Docker network
```yaml
networks:
  - your_postgres_network

networks:
  your_postgres_network:
    external: true
```

---

## Logs

```bash
docker compose logs -f
```

## Stop / Restart

```bash
docker compose down
docker compose up -d
```

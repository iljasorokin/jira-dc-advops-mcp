# jira-dc-advops-mcp

Local MCP helpers for Jira Data Center advanced ops used from Cursor.

Русская документация: [README.ru.md](./README.ru.md).

First capability: **read Tempo Structure boards** (hierarchy + column values)
via Structure REST `/rest/structure/2.0/*`.

Talks to the **same proxy/auth** as `@atlassian-dc-mcp/jira`
(`JIRA_HOST=https://localhost:8444` + token from keychain). Prefer these
tools over inventing raw `curl` to `jr.upzero.net`.

Example board URL: `https://jr.upzero.net/secure/StructureBoard.jspa?s=182`
→ `structureId = 182`.

## Auth

Same sources as `@atlassian-dc-mcp/jira`:

- `JIRA_HOST` (env or `~/.atlassian-dc-mcp/jira.env`)
- `JIRA_API_TOKEN` (env), or macOS Keychain service `atlassian-dc-mcp` / account `jira-token`

## Tools (read)

| Tool | When |
|------|------|
| `structure_list` | List structures visible to the user (`name` filter optional) |
| `structure_get` | Structure metadata by id (name, owner, permissions flags) |
| `structure_getForest` | Raw forest (`formula` + parsed flat rows) for a structure |
| `structure_getValues` | Attribute matrix for given `rows` (key/summary/status/…) |
| `structure_getBoard` | **Fast path:** forest + values as nested tree (default attrs) |
| `structure_getBoardToFile` | Same as getBoard, dump JSON to a local file (large boards) |

### Fast path for a Structure Board

```
structure_getBoard
  structureId: 182
  # optional attributes override; default: key, summary, status, issuetype
```

Returns nested `{ rowId, depth, issueId?, itemType?, values, children[] }`.

Generators / loop markers are included unless `includeGenerators: false`.

### Forest formula

Structure returns a serialized `formula`. This MCP parses it into rows:

`rowId:depth:itemIdentity` where `itemIdentity` is either an issue id
(`14707`) or a typed id (`5/240` → folder / generator / … via `itemTypes`).

## Cursor config

```json
"jira-dc-advops": {
  "command": "node",
  "args": ["/Users/iljasorokin/jira-dc-advops-mcp/index.js"],
  "env": {
    "JIRA_HOST": "https://localhost:8444",
    "NODE_TLS_REJECT_UNAUTHORIZED": "0"
  }
}
```

After changing `index.js`, reload MCP servers in Cursor so new tools appear.

## Notes

- Write/update forest (`/forest/update`) is **not** exposed yet — read-only v1.
- For issue details beyond Structure columns, use `user-jira-dc` (`jira_getIssue` / JQL).
- Large boards: prefer `structure_getBoardToFile` over stuffing the full tree into chat.

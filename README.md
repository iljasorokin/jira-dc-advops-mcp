# jira-dc-advops-mcp

Local MCP helpers for Jira Data Center advanced ops used from Cursor.

Русская документация: [README.ru.md](./README.ru.md).

First capability: **read / update Tempo Structure boards** (hierarchy + column values)
via Structure REST `/rest/structure/2.0/*`.

Talks to the **same proxy/auth** as `@atlassian-dc-mcp/jira`
(local TLS proxy + token from keychain / env). Prefer these tools over
ad-hoc `curl` to the public Jira hostname.

`structureId` comes from `StructureBoard.jspa?s=<id>`.

## Auth

Same sources as `@atlassian-dc-mcp/jira`:

- `JIRA_HOST` (env or `~/.atlassian-dc-mcp/jira.env`) — typically your local proxy, e.g. `https://localhost:8444`
- `JIRA_API_TOKEN` (env), or macOS Keychain service `atlassian-dc-mcp` / account `jira-token`

Do **not** commit tokens or `*.env` files.

## Tools (read)

| Tool | When |
|------|------|
| `structure_list` | List structures visible to the user (`name` filter optional) |
| `structure_get` | Structure metadata by id (name, owner, permissions flags) |
| `structure_getForest` | Raw forest (`formula` + parsed flat rows) for a structure |
| `structure_getValues` | Attribute matrix for given `rows` (key/summary/status/…) |
| `structure_getBoard` | **Fast path:** forest + values as nested tree (default attrs) |
| `structure_getBoardToFile` | Same as getBoard, dump JSON to a local file (large boards) |
| `structure_listFolders` | Folders in a structure (`rowId`, name/summary, `folderId`) |

## Tools (write)

| Tool | When |
|------|------|
| `structure_addIssues` | Add issue(s) under a folder / parent row (`underRowId` \| `folderName` \| `folderId`) |

### Add issues under a folder

```
structure_listFolders
  structureId: 123

structure_addIssues
  structureId: 123
  folderName: "My folder"   # or underRowId: <rowId>
  issueKeys: ["PROJ-1", "PROJ-2"]
  # skipIfPresent: true (default)
```

Uses `POST /rest/structure/2.0/forest/update` with `action: add`. Resolves issue keys → numeric ids. Skips issues already direct children of the parent unless `skipIfPresent: false`.

### Fast path for a Structure Board

```
structure_getBoard
  structureId: 123
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
  "args": ["/path/to/jira-dc-advops-mcp/index.js"],
  "env": {
    "JIRA_HOST": "https://localhost:8444",
    "NODE_TLS_REJECT_UNAUTHORIZED": "0"
  }
}
```

After changing `index.js`, reload MCP servers in Cursor so new tools appear.

## Notes

- Forest write beyond `structure_addIssues` (move/remove rows, create folders) is not exposed yet.
- For issue details beyond Structure columns, use `user-jira-dc` (`jira_getIssue` / JQL).
- Large boards: prefer `structure_getBoardToFile` over stuffing the full tree into chat.

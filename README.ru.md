# jira-dc-advops-mcp

Локальные MCP-инструменты для расширенных операций Jira Data Center в Cursor.

Возможности: **чтение и точечная запись Tempo Structure** (иерархия + значения колонок)
через Structure REST `/rest/structure/2.0/*`.

Работает через **тот же proxy/auth**, что и `@atlassian-dc-mcp/jira`
(локальный TLS-proxy + токен из Keychain / env). Предпочитать эти tools
вместо ad-hoc `curl` к публичному hostname Jira.

`structureId` берётся из `StructureBoard.jspa?s=<id>`.

Английская версия: [README.md](./README.md).

## Авторизация

Те же источники, что у `@atlassian-dc-mcp/jira`:

- `JIRA_HOST` (env или `~/.atlassian-dc-mcp/jira.env`) — обычно локальный proxy, напр. `https://localhost:8444`
- `JIRA_API_TOKEN` (env) или macOS Keychain: service `atlassian-dc-mcp` / account `jira-token`

Токены и `*.env` **не** коммитить. См. [SECURITY.md](./SECURITY.md).

## Tools (чтение)

| Tool | Когда использовать |
|------|--------------------|
| `structure_list` | Список Structure, видимых пользователю (опциональный фильтр `name`) |
| `structure_get` | Метаданные Structure по id (имя, владелец, флаги прав) |
| `structure_getForest` | Сырой forest (`formula` + разобранные плоские строки) |
| `structure_getValues` | Матрица атрибутов для заданных `rows` (key/summary/status/…) |
| `structure_getBoard` | **Быстрый путь:** forest + values как вложенное дерево (атрибуты по умолчанию) |
| `structure_getBoardToFile` | То же, что getBoard, выгрузка JSON в локальный файл (крупные доски) |
| `structure_listFolders` | Папки в структуре (`rowId`, имя/summary, `folderId`) |

## Tools (запись)

| Tool | Когда использовать |
|------|--------------------|
| `structure_addIssues` | Добавить issue(и) под папку / родительский row (`underRowId` \| `folderName` \| `folderId`) |

### Добавить задачи в папку

```
structure_listFolders
  structureId: 123

structure_addIssues
  structureId: 123
  folderName: "Моя папка"   # или underRowId: <rowId>
  issueKeys: ["PROJ-1", "PROJ-2"]
  # skipIfPresent: true (по умолчанию)
```

Использует `POST /rest/structure/2.0/forest/update` с `action: add`. Ключи issue → числовые id. Уже лежащие прямыми детьми parent — пропускаются, пока `skipIfPresent` не `false`.

### Быстрый путь для Structure Board

```
structure_getBoard
  structureId: 123
  # optional: переопределение attributes; по умолчанию: key, summary, status, issuetype
```

Возвращает вложенное `{ rowId, depth, issueId?, itemType?, values, children[] }`.

Генераторы / loop-маркеры включаются, пока не передать `includeGenerators: false`.

### Формула forest

Structure отдаёт сериализованную `formula`. MCP разбирает её в строки:

`rowId:depth:itemIdentity`, где `itemIdentity` — либо id задачи
(`14707`), либо typed id (`5/240` → folder / generator / … через `itemTypes`).

## Конфиг Cursor

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

После правок `index.js` перезагрузить MCP servers в Cursor, чтобы появились новые tools.

## Замечания

- Запись forest кроме `structure_addIssues` (move/remove, создание папок) пока не вынесена.
- Детали issue сверх колонок Structure — через `user-jira-dc` (`jira_getIssue` / JQL).
- Крупные доски: предпочитать `structure_getBoardToFile`, не засовывать полное дерево в чат.

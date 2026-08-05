# jira-dc-advops-mcp

Локальные MCP-инструменты для расширенных операций Jira Data Center в Cursor.

Первая возможность: **чтение досок Tempo Structure** (иерархия + значения колонок)
через Structure REST `/rest/structure/2.0/*`.

Работает через **тот же proxy/auth**, что и `@atlassian-dc-mcp/jira`
(`JIRA_HOST=https://localhost:8444` + токен из Keychain). Предпочитать
эти tools вместо ad-hoc `curl` к `jr.upzero.net`.

Пример URL доски: `https://jr.upzero.net/secure/StructureBoard.jspa?s=182`
→ `structureId = 182` (в формулировках: Структура «Самоограниченные»).

Английская версия: [README.md](./README.md).

## Авторизация

Те же источники, что у `@atlassian-dc-mcp/jira`:

- `JIRA_HOST` (env или `~/.atlassian-dc-mcp/jira.env`)
- `JIRA_API_TOKEN` (env) или macOS Keychain: service `atlassian-dc-mcp` / account `jira-token`

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
  structureId: 182

structure_addIssues
  structureId: 182
  folderName: "Орг. задачи"   # или underRowId: 29396
  issueKeys: ["MNG-2538", "SCRM-15318"]
  # skipIfPresent: true (по умолчанию)
```

Использует `POST /rest/structure/2.0/forest/update` с `action: add`. Ключи issue → числовые id. Уже лежащие прямыми детьми parent — пропускаются, пока `skipIfPresent` не `false`.

### Быстрый путь для Structure Board

```
structure_getBoard
  structureId: 182
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
  "args": ["/Users/iljasorokin/jira-dc-advops-mcp/index.js"],
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

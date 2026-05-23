# Multi-Agent Guide

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

---

### Overview

minimum-headroom supports spawning helper coding agents in isolated worktrees, each with their own tmux pane, face tile, and permission configuration. The operator controls helpers from the browser UI or via MCP tools.

If you are using the minimum-headroom operator/helper runtime, also install the `minimum-headroom-ops` skill. It documents the expected MCP lifecycle flow and the helper reporting contract used by the operator-led workflow.

### Spawning Helpers

- **Desktop:** click the current-agent bar, open the Agents surface, then click **+Agent**
- **Mobile:** tap the current-agent bar, open the agent list, then tap **+Agent**
- **+Agent** uses auto-generated readable helper ids (`helper-1`, `helper-2`, ...), plus generated branch and worktree defaults
- When the operator was started with `--repo`, helpers inherit that target repository
- Desktop renders the operator plus up to 7 helpers (8 tiles total)
- Via MCP, `agent.spawn` accepts `id` as the canonical helper-name field and also accepts `agent_id` as a compatibility alias

### Permission Presets

`agent.spawn` accepts a `permission_preset` parameter (`reviewer`, `implementer`, `full`) to auto-configure tool permissions for the helper.

For Claude Code, Antigravity CLI, and Codex CLI, these presets complement the runtime's own setup. They do not replace project-local agent instructions such as `AGENTS.md` or signaling rules like `doc/examples/AGENT_RULES.md`.

| Preset | Claude Code | Antigravity CLI | Codex CLI |
|--------|-------------|------------|-----------|
| `reviewer` | Read, Glob, Grep, agent\_report (allow); no Bash | sandboxed read-oriented command allow-list | `-a untrusted` |
| `implementer` | + Edit, Write, Bash; deny `git push` | sandboxed commands, deny `git push`, append `--dangerously-skip-permissions` | `--full-auto` |
| `full` | same as `implementer` | same as `implementer` | `--full-auto` |

For detailed per-runtime setup, see:
- [Claude Code setup](../examples/claude-code/README.md)
- [Antigravity setup](../examples/antigravity/README.md)
- [Codex setup](../examples/codex/config.toml)

Antigravity CLI helpers may require first-run interaction even with permission presets. A new generated worktree can show a workspace trust prompt before mission injection is possible, and the first MCP tool calls can ask for conversation-scoped approval. Confirm trust for the generated helper worktree and allow `minimum_headroom/agent_report` at minimum; face tools may prompt separately if the helper calls them.

### Mission Assignment and Delivery

- Store missions with `agent.assign`, specifying:
  - `role` — the helper's function (e.g. `reviewer`, `implementer`)
  - `target_paths` — files or directories the helper should focus on
  - `completion_criteria` — what counts as success
  - `timebox_minutes` — hard time bound for the current pass
  - `max_findings` — cap on findings before the helper should report back
- Deliver missions via `agent.inject` using controlled tmux paste-buffer injection
- Delivery is tracked through states: `pending` → `sent_to_tmux` → `acked` / `failed` / `timeout`
- Check those delivery and ack states with `agent.assignment.list`
- A matching `agent.report` from the helper acknowledges the mission

### Helper Reporting and Owner Inbox

- Helpers report status via `agent.report` with one of these types:
  - `progress` — work underway, first report serves as mission-accept handshake
  - `blocked` — helper cannot proceed without owner action
  - `question` — helper needs clarification
  - `done` — mission complete
  - `review_findings` — review results ready for owner
- Reports land in a durable owner inbox that survives browser reloads
- The owner resolves items with `owner.inbox.resolve`
- Unresolved items keep helper and owner attention visible in the UI

### Focus and Retargeting

- Click or tap a tile or list row to change the operator's focus target
- `agent.focus` changes visibility, not ownership
- Focusing a helper does not transfer user-facing authority; only the operator speaks to the user

### Stuck Detection and Pane Control

A helper can stall inside a CLI-level modal (a tool-approval prompt, a model picker, a "you've hit your usage limit" notice, a CLI feedback survey) where the underlying LLM is not even reading input. The injected mission text never reaches the model in those states, and `agent.assignment.list` will eventually show `delivery_state=timeout` without any helpful diagnosis. To make that visible and recoverable from any MCP client, the runtime ships three pieces:

- A background **stuck-detector** runs inside face-app (default interval 5s, disable with `MH_HELPER_STUCK_DETECTOR=off`). On each tick it captures every active helper's pane tail and matches it against a small pattern set (`Do you want to proceed?`, `Switch to gpt-…`, `You've hit your usage limit`, `How's the CLI experience`, `Press enter to confirm`). On a fresh match it posts a `kind=blocked` report to the owner inbox with the matched line and a snippet of pane context in `detail`. Same `(agent, pattern, matched line)` matches are deduped for ~30 seconds so the inbox does not flood.
- **`agent.pane_snapshot { agent_id, tail_lines? }`** returns the last N lines (default 40, max 400) of a helper's pane with ANSI stripped. Use it when the inbox `blocked` report points at a helper and you want to see the full modal text before deciding what to press.
- **`agent.pane_send_key { agent_id, keys, literal? }`** sends raw tmux keys to a helper's pane. `keys` accepts printable ASCII (`"2"`, `"hello world"`) and a named-key allowlist (`Enter`, `Escape`, `Tab`, `BSpace`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `C-c`, `C-m`, `C-d`). Set `literal: true` to add `-l --` so tmux treats the strings as text instead of key names — useful when typing free-form input into a CLI selector. This tool is for answering CLI modals, **not** for delivering missions; use `agent.inject` for missions.

Typical recovery flow:

1. The owner inbox shows `{kind: "blocked", summary: "helper paused on approval prompt", from_agent_id: "helper-1"}` (or `"... on model picker"`, etc).
2. Call `agent.pane_snapshot agent_id=helper-1 tail_lines=30` to see the full modal.
3. Pick the right response keys and call `agent.pane_send_key agent_id=helper-1 keys=["2","Enter"]` (numbered selectors) or `keys=["Down","Enter"]` (arrow-key selectors).
4. Optionally call `agent.pane_snapshot` once more to confirm the modal cleared. If the mission text was lost while the modal held input, re-inject with `agent.inject`.
5. Resolve the auto `blocked` report with `owner.inbox.resolve action=resolved` so it does not stay on the inbox.

The detector posts reports; it never auto-presses keys. The operator (or the user) decides the response. This keeps irreversible choices like `No, and always deny` from happening on a regex match.

### Worktree Isolation and Security

- Each helper gets an isolated git worktree on its own branch
- `git push` is denied for all helper permission presets:
  - **Claude Code:** `deniedTools` includes `Bash(git push*)`
  - **Antigravity / Codex:** constrained by agent instructions
- Settings files (e.g. `.claude/settings.json`) are set to `chmod 444` after write so helpers cannot modify their own permissions

### Deleting Helpers

- The **Delete** button removes the tmux pane, worktree, runtime record, assignment records, and owner-inbox records together
- Via MCP: `agent.delete`

### Shutdown and Recovery

- Startup is cleanup-first: previously registered helpers are deleted or purged instead of being auto-restored
- Active-stream helpers are removed from tmux, worktrees, runtime state, assignment state, and owner inbox state
- Hidden helper records from other repositories are purged from the current repository's runtime state instead of lingering as ghosts
- If explicit helper resume is added later, it should be an operator action, not an automatic startup side effect

---

<a id="japanese"></a>
## 日本語

---

### 概要

minimum-headroom は、分離された worktree に helper コーディングエージェントを生成する機能を備えています。各 helper は独自の tmux ペイン、顔タイル、権限設定を持ちます。operator はブラウザ UI または MCP ツールから helper を制御します。

minimum-headroom の operator/helper runtime を使う場合は、`minimum-headroom-ops` スキルも導入してください。operator 主導フローで使う標準 MCP ライフサイクルと helper reporting contract をまとめています。

### Helper の生成

- **Desktop:** 現在エージェントバーをクリック → Agents サーフェス → **+Agent**
- **Mobile:** 現在エージェントバーをタップ → agent list → **+Agent**
- **+Agent** は `helper-1`, `helper-2`, ... のような読みやすい自動 id と、branch / worktree のデフォルトを使用
- `--repo` 付きで operator を起動した場合、helper は target repository を継承
- Desktop は operator + helper 最大 7 体を同時表示（合計 8 タイル）
- MCP の `agent.spawn` では canonical な helper 名フィールドは `id` ですが、互換 alias として `agent_id` も受け付けます

### 権限プリセット

`agent.spawn` で `permission_preset`（`reviewer` / `implementer` / `full`）を指定すると、ツール承認を自動設定します。

Claude Code / Antigravity CLI / Codex CLI では、これらのプリセットは各ランタイムのセットアップを補完するものであり、置き換えるものではありません。project-local の `AGENTS.md` や `doc/examples/AGENT_RULES.md` のようなエージェント指示もあわせて設定してください。

| プリセット | Claude Code | Antigravity CLI | Codex CLI |
|--------|-------------|------------|-----------|
| `reviewer` | Read, Glob, Grep, agent\_report (allow); Bash なし | sandboxed read-oriented command allow-list | `-a untrusted` |
| `implementer` | + Edit, Write, Bash; `git push` を拒否 | sandboxed commands, deny `git push`, append `--dangerously-skip-permissions` | `--full-auto` |
| `full` | `implementer` と同一 | `implementer` と同一 | `--full-auto` |

各ランタイムの詳細設定:
- [Claude Code セットアップ](../examples/claude-code/README.md)
- [Antigravity セットアップ](../examples/antigravity/README.md)
- [Codex セットアップ](../examples/codex/config.toml)

Antigravity CLI helper は、権限プリセットを使っても初回だけ対話が必要になることがあります。新規生成された worktree では mission 注入前に workspace trust prompt が出る場合があり、最初の MCP tool call でも conversation-scoped approval を求められます。生成された helper worktree を trust し、最低限 `minimum_headroom/agent_report` を許可してください。helper が face tool を呼ぶ場合は `face_ping` / `face_event` / `face_say` も個別に承認が出ることがあります。

### ミッション割当と配信

- `agent.assign` でミッションを保存。指定可能なフィールド:
  - `role` — helper の役割（例: `reviewer`, `implementer`）
  - `target_paths` — helper が対象とするファイルやディレクトリ
  - `completion_criteria` — 成功の定義
  - `timebox_minutes` — 現在のパスの制限時間
  - `max_findings` — 報告前の findings 上限
- `agent.inject` で制御された tmux paste-buffer 注入により配信
- 配信状態は `pending` → `sent_to_tmux` → `acked` / `failed` / `timeout` で追跡
- これらの配信状態や ack は `agent.assignment.list` で確認
- helper からの `agent.report` の一致で ack（受領確認）

### Helper レポートと Owner Inbox

- helper は `agent.report` で以下のタイプで報告:
  - `progress` — 作業中。最初の report はミッション受諾のハンドシェイク
  - `blocked` — owner のアクションなしでは続行不可
  - `question` — 確認が必要
  - `done` — ミッション完了
  - `review_findings` — レビュー結果の提出
- レポートは durable な owner inbox に保存（ブラウザリロード後も維持）
- `owner.inbox.resolve` で解決
- 未解決項目は helper / owner の attention を UI 上で維持

### フォーカスとリターゲット

- タイルまたはリスト行をクリック・タップして operator の接続先を切り替え
- `agent.focus` は表示を変更するだけで ownership は変わらない
- helper にフォーカスしてもユーザー対面の権限は移譲されない。ユーザーに話しかけるのは operator のみ

### Stuck 検出と Pane 制御

helper は CLI レベルのモーダル（ツール承認プロンプト、モデルピッカー、利用上限通知、CLI フィードバックサーベイなど）に入るとそこで停止し、内側の LLM は入力を読まなくなります。injection したミッション文はモデルに届かず、`agent.assignment.list` ではただ `delivery_state=timeout` になるだけで原因は分かりません。これを MCP クライアント側から見えて復旧可能にするために、ランタイムは3つの仕組みを提供します。

- バックグラウンドの **stuck-detector** が face-app 内で動作します（既定 5 秒間隔、`MH_HELPER_STUCK_DETECTOR=off` で無効化可能）。tick ごとに全アクティブ helper の pane 末尾を取得し、小さなパターン集合（`Do you want to proceed?` / `Switch to gpt-…` / `You've hit your usage limit` / `How's the CLI experience` / `Press enter to confirm`）と照合します。新規ヒットがあると `kind=blocked` レポートを owner inbox に投函し、`detail` に一致行と pane の周辺コンテキストを入れます。同一の `(agent, pattern, matched line)` は約 30 秒間 dedupe されるので inbox が荒れません。
- **`agent.pane_snapshot { agent_id, tail_lines? }`** は helper の pane 末尾 N 行（既定 40、最大 400）を ANSI 除去で返します。inbox の `blocked` レポートが指し示した helper のモーダル本文を確認してから対応を決めるために使います。
- **`agent.pane_send_key { agent_id, keys, literal? }`** は helper の pane に生の tmux キーを送信します。`keys` は印字可能 ASCII（`"2"`, `"hello world"`）と名前付きキーの allowlist（`Enter`, `Escape`, `Tab`, `BSpace`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `C-c`, `C-m`, `C-d`）を受け付けます。`literal: true` を指定すると tmux に `-l --` を付けて文字列をテキストとして扱うので、CLI セレクタへの自由入力に向きます。このツールは **CLI モーダルへの応答用** であって、ミッション配信には使いません。ミッションは `agent.inject` を使ってください。

典型的な復旧フロー:

1. owner inbox に `{kind: "blocked", summary: "helper paused on approval prompt", from_agent_id: "helper-1"}`（または `"... on model picker"` など）が現れる
2. `agent.pane_snapshot agent_id=helper-1 tail_lines=30` でモーダル本文を確認
3. 適切な応答キーを選び `agent.pane_send_key agent_id=helper-1 keys=["2","Enter"]`（番号セレクタ）または `keys=["Down","Enter"]`（矢印セレクタ）を送る
4. 必要に応じてもう一度 `agent.pane_snapshot` でモーダル解除を確認。モーダルが入力を握っていた間にミッション文が失われた場合は `agent.inject` で再投入
5. 自動 `blocked` レポートは `owner.inbox.resolve action=resolved` で片付ける

検出器はレポートを投函するだけで、キーを自動で押すことはしません。応答は operator（または user）が判断します。これにより、正規表現一致で `No, and always deny` のような取り返しのつかない選択肢を踏むことを防ぎます。

### Worktree 分離とセキュリティ

- 各 helper は独自ブランチ上の分離された git worktree を取得
- `git push` は全プリセットで拒否:
  - **Claude Code:** `deniedTools` に `Bash(git push*)` を含む
  - **Antigravity / Codex:** エージェント指示で制約
- 権限設定ファイル（例: `.claude/settings.json`）は書き込み後 `chmod 444` で保護され、helper が自身の権限を変更できない

### Helper の削除

- **Delete** ボタンで tmux ペイン、worktree、runtime record、assignment record、owner inbox record をまとめて削除
- MCP 経由: `agent.delete`

### シャットダウンと復旧

- 起動時の既定動作は cleanup-first です。以前の helper は自動復元せず、削除または state から purge します
- active stream の helper は tmux / worktree / runtime state / assignment state / owner inbox state から除去されます
- 他 repository に属する hidden helper record も、現在の repository 側 state には残さず purge します
- 将来 resume を足す場合でも、起動時の自動復元ではなく operator の明示操作で行う想定です

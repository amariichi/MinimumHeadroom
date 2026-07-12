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
| `reviewer` | Read, Glob, Grep, agent\_report (allow); no Bash | sandboxed read-oriented command allow-list | `-s read-only -a never` |
| `implementer` | + Edit, Write, Bash; deny `git push` | sandboxed commands, deny direct `git push` command forms, append `--dangerously-skip-permissions` | `-s workspace-write -a never --add-dir <sourceRepo>/.git` |
| `full` | same as `implementer` | same as `implementer` | `--dangerously-bypass-approvals-and-sandbox` |

Antigravity presets are session-scoped: all launch with `--sandbox`, and the
helper process receives `MH_AGY_PERMISSION_PRESET`. The installed
minimum-headroom plugin runs `scripts/agy-helper-policy.mjs` before terminal
commands. It allows the reviewer read-command subset, forces review for other
reviewer commands, and denies direct `git push` for every helper preset. Normal
interactive agy sessions have no preset variable, so the hook returns no policy
override.

Codex preset suffixes can be replaced completely with environment overrides:

- `MH_CODEX_PRESET_REVIEWER`
- `MH_CODEX_PRESET_IMPLEMENTER`
- `MH_CODEX_PRESET_FULL`

For Codex commands that request `-s read-only` or `-s workspace-write`, helper spawn runs a one-time server-process sandbox preflight: `timeout 15 codex sandbox -- echo __mh_userns_ok__`. If the token is not observed, spawn rewrites that sandbox mode to `-s danger-full-access`, records `sandbox_fallback: true` and a reason in the spawn result, and sets the helper's status message to explain the downgrade. This prevents a preset from silently launching a Codex helper that cannot run commands on hosts where user namespaces are blocked.

After tmux pane creation, helper spawn verifies that the CLI actually took over the pane. It polls `pane_current_command` for up to about 15 seconds and treats a remaining plain shell (`bash`, `zsh`, `sh`, `dash`, or `fish`) as `launch_failed`. The helper record is kept for inspection, and the spawn result includes the last pane lines so the operator can see why launch failed.

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
- The default delivery acknowledgment timeout is 120 seconds, which allows cold-starting CLIs time to load before a delivery is marked timed out
- `agent.inject` refuses to paste mission text into a pane whose current command is a plain shell, returning `injection_refused_shell_pane` with a short pane tail; pass `force_shell_inject: true` only for intentional shell recovery
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
- Assignment target paths are read references under the stream root; helpers should make edits and commits only inside their assigned worktree on the helper branch, never in the source repository checkout
- Helper publishing controls differ by runtime:
  - **Claude Code:** `deniedTools` includes `Bash(git push*)`
  - **Antigravity:** `agy-helper-policy.mjs` returns a `PreToolUse` deny decision for direct `git push` command forms; this is a command-text guardrail, not a hostile-shell security boundary
  - **Codex:** constrained by agent instructions, not a technical deny rule
- Generated settings files where used (currently Claude Code) are set to `chmod 444` after write so helpers cannot modify their own permissions

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

minimum-headroom は、分離されたワークツリーにヘルパーのコーディングエージェントを生成する機能を備えています。各ヘルパーは独自の tmux ペイン、顔タイル、権限設定を持ちます。オペレーターはブラウザ画面または MCP ツールからヘルパーを制御します。

minimum-headroom のオペレーター/ヘルパー実行環境を使う場合は、`minimum-headroom-ops` スキルも導入してください。オペレーター主導フローで使う標準 MCP ライフサイクルとヘルパーレポート規約をまとめています。

### ヘルパーの生成

- **Desktop:** 現在エージェントバーをクリック → Agents サーフェス → **+Agent**
- **Mobile:** 現在エージェントバーをタップ → agent list → **+Agent**
- **+Agent** は `helper-1`, `helper-2`, ... のような読みやすい自動 ID と、ブランチ / ワークツリーの既定値を使用
- `--repo` 付きでオペレーターを起動した場合、ヘルパーは対象リポジトリを継承
- Desktop はオペレーター + ヘルパー最大 7 体を同時表示（合計 8 タイル）
- MCP の `agent.spawn` では標準のヘルパー名フィールドは `id` ですが、互換エイリアスとして `agent_id` も受け付けます

### 権限プリセット

`agent.spawn` で `permission_preset`（`reviewer` / `implementer` / `full`）を指定すると、ツール承認を自動設定します。

Claude Code / Antigravity CLI / Codex CLI では、これらのプリセットは各ランタイムのセットアップを補完するものであり、置き換えるものではありません。プロジェクトローカルの `AGENTS.md` や `doc/examples/AGENT_RULES.md` のようなエージェント指示もあわせて設定してください。

| プリセット | Claude Code | Antigravity CLI | Codex CLI |
|--------|-------------|------------|-----------|
| `reviewer` | Read, Glob, Grep, agent\_report (allow); Bash なし | sandboxed read-oriented command allow-list | `-s read-only -a never` |
| `implementer` | + Edit, Write, Bash; `git push` を拒否 | sandboxed commands, 直接的な `git push` コマンド形式を拒否, append `--dangerously-skip-permissions` | `-s workspace-write -a never --add-dir <sourceRepo>/.git` |
| `full` | `implementer` と同一 | `implementer` と同一 | `--dangerously-bypass-approvals-and-sandbox` |

Antigravity のプリセットはセッション単位です。全て `--sandbox` で起動し、helper
プロセスへ `MH_AGY_PERMISSION_PRESET` を渡します。インストール済みpluginの
`scripts/agy-helper-policy.mjs` がコマンド実行前に、reviewerの読み取りコマンドを許可、
それ以外を強制確認し、全helper presetの直接的な `git push` を拒否します。通常の
対話agyにはpreset環境変数がないため、このhookはpolicyを上書きしません。

Codex のプリセット末尾引数は、以下の環境変数で丸ごと置き換えできます。

- `MH_CODEX_PRESET_REVIEWER`
- `MH_CODEX_PRESET_IMPLEMENTER`
- `MH_CODEX_PRESET_FULL`

Codex コマンドが `-s read-only` または `-s workspace-write` を要求する場合、ヘルパー生成時にサーバープロセスごとに一度だけ `timeout 15 codex sandbox -- echo __mh_userns_ok__` を実行してサンドボックスを事前確認します。確認トークンが見つからない場合、そのサンドボックスモードを `-s danger-full-access` に書き換え、生成結果に `sandbox_fallback: true` と理由を含め、ヘルパーの状態メッセージにも権限緩和の理由を残します。user namespace が制限されたホストでも、コマンド実行不能な Codex ヘルパーを無言で作らないためです。

tmux ペイン作成後、ヘルパー生成は CLI が実際に起動したかを確認します。約 15 秒間 `pane_current_command` をポーリングし、素のシェル（`bash`, `zsh`, `sh`, `dash`, `fish`）のままなら `launch_failed` として扱います。ヘルパー記録は調査用に残し、生成結果にはペイン末尾が含まれます。

各ランタイムの詳細設定:
- [Claude Code セットアップ](../examples/claude-code/README.md)
- [Antigravity セットアップ](../examples/antigravity/README.md)
- [Codex セットアップ](../examples/codex/config.toml)

Antigravity CLI ヘルパーは、権限プリセットを使っても初回だけ対話が必要になることがあります。新規生成されたワークツリーではミッション注入前にワークスペース信頼プロンプトが出る場合があり、最初の MCP ツール呼び出しでも会話単位の承認を求められます。生成されたヘルパーワークツリーを信頼し、最低限 `minimum_headroom/agent_report` を許可してください。ヘルパーがフェイスツールを呼ぶ場合は `face_ping` / `face_event` / `face_say` も個別に承認が出ることがあります。

### ミッション割当と配信

- `agent.assign` でミッションを保存。指定可能なフィールド:
  - `role` — helper の役割（例: `reviewer`, `implementer`）
  - `target_paths` — helper が対象とするファイルやディレクトリ
  - `completion_criteria` — 成功の定義
  - `timebox_minutes` — 現在のパスの制限時間
  - `max_findings` — 報告前の findings 上限
- `agent.inject` で制御された tmux ペーストバッファ注入により配信
- 配信状態は `pending` → `sent_to_tmux` → `acked` / `failed` / `timeout` で追跡
- 配信の受領確認タイムアウトの既定値は 120 秒です。コールドスタートする CLI が読み込まれる前にタイムアウト扱いになるのを避けます
- `agent.inject` は、ペインの現在コマンドが素のシェルの場合、ミッション文の貼り付けを拒否して `injection_refused_shell_pane` と短いペイン末尾を返します。シェル復旧として意図的に入力したい場合だけ `force_shell_inject: true` を指定してください
- これらの配信状態や受領確認は `agent.assignment.list` で確認
- ヘルパーからの `agent.report` の一致で受領確認

### ヘルパーレポートと Owner Inbox

- ヘルパーは `agent.report` で以下のタイプで報告:
  - `progress` — 作業中。最初のレポートはミッション受諾のハンドシェイク
  - `blocked` — owner のアクションなしでは続行不可
  - `question` — 確認が必要
  - `done` — ミッション完了
  - `review_findings` — レビュー結果の提出
- レポートは永続化された owner inbox に保存（ブラウザリロード後も維持）
- `owner.inbox.resolve` で解決
- 未解決項目はヘルパー / オーナーの注意喚起を UI 上で維持

### フォーカスとリターゲット

- タイルまたはリスト行をクリック・タップしてオペレーターの接続先を切り替え
- `agent.focus` は表示を変更するだけで所有権は変わらない
- ヘルパーにフォーカスしてもユーザー対面の権限は移譲されない。ユーザーに話しかけるのはオペレーターのみ

### 停止検出とペイン制御

ヘルパーは CLI レベルのモーダル（ツール承認プロンプト、モデルピッカー、利用上限通知、CLI フィードバックサーベイなど）に入るとそこで停止し、内側の LLM は入力を読まなくなります。注入したミッション文はモデルに届かず、`agent.assignment.list` ではただ `delivery_state=timeout` になるだけで原因は分かりません。これを MCP クライアント側から見えて復旧可能にするために、ランタイムは3つの仕組みを提供します。

- バックグラウンドの **停止検出器** が face-app 内で動作します（既定 5 秒間隔、`MH_HELPER_STUCK_DETECTOR=off` で無効化可能）。tick ごとに全アクティブヘルパーのペイン末尾を取得し、小さなパターン集合（`Do you want to proceed?` / `Switch to gpt-…` / `You've hit your usage limit` / `How's the CLI experience` / `Press enter to confirm`）と照合します。新規ヒットがあると `kind=blocked` レポートを owner inbox に投函し、`detail` に一致行とペインの周辺コンテキストを入れます。同一の `(agent, pattern, matched line)` は約 30 秒間重複排除されるので inbox が荒れません。
- **`agent.pane_snapshot { agent_id, tail_lines? }`** はヘルパーのペイン末尾 N 行（既定 40、最大 400）を ANSI 除去で返します。inbox の `blocked` レポートが指し示したヘルパーのモーダル本文を確認してから対応を決めるために使います。
- **`agent.pane_send_key { agent_id, keys, literal? }`** はヘルパーのペインに生の tmux キーを送信します。`keys` は印字可能 ASCII（`"2"`, `"hello world"`）と名前付きキーの許可リスト（`Enter`, `Escape`, `Tab`, `BSpace`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `C-c`, `C-m`, `C-d`）を受け付けます。`literal: true` を指定すると tmux に `-l --` を付けて文字列をテキストとして扱うので、CLI セレクタへの自由入力に向きます。このツールは **CLI モーダルへの応答用** であって、ミッション配信には使いません。ミッションは `agent.inject` を使ってください。

典型的な復旧フロー:

1. owner inbox に `{kind: "blocked", summary: "helper paused on approval prompt", from_agent_id: "helper-1"}`（または `"... on model picker"` など）が現れる
2. `agent.pane_snapshot agent_id=helper-1 tail_lines=30` でモーダル本文を確認
3. 適切な応答キーを選び `agent.pane_send_key agent_id=helper-1 keys=["2","Enter"]`（番号セレクタ）または `keys=["Down","Enter"]`（矢印セレクタ）を送る
4. 必要に応じてもう一度 `agent.pane_snapshot` でモーダル解除を確認。モーダルが入力を握っていた間にミッション文が失われた場合は `agent.inject` で再投入
5. 自動 `blocked` レポートは `owner.inbox.resolve action=resolved` で片付ける

検出器はレポートを投函するだけで、キーを自動で押すことはしません。応答は operator（または user）が判断します。これにより、正規表現一致で `No, and always deny` のような取り返しのつかない選択肢を踏むことを防ぎます。

### Worktree 分離とセキュリティ

- 各ヘルパーは独自ブランチ上の分離された git ワークツリーを取得
- assignment の target paths は stream root 配下の読み取り参照です。ヘルパーは編集とコミットを、元リポジトリのチェックアウトではなく割り当てられたワークツリー上のヘルパーブランチで行います
- helperのpublish制御はruntimeごとに異なります:
  - **Claude Code:** `deniedTools` に `Bash(git push*)` を含む
  - **Antigravity:** `agy-helper-policy.mjs` が直接的な `git push` コマンド形式へ `PreToolUse` のdeny判定を返す。これはコマンド文字列のguardrailであり、難読化されたshellに対するセキュリティ境界ではありません
  - **Codex:** エージェント指示で制約し、技術的なdeny ruleは持ちません
- 生成する権限設定ファイル（現在はClaude Code）は書き込み後 `chmod 444` で保護され、ヘルパーが自身の権限を変更できない

### ヘルパーの削除

- **Delete** ボタンで tmux ペイン、ワークツリー、実行時記録、割当記録、owner inbox 記録をまとめて削除
- MCP 経由: `agent.delete`

### シャットダウンと復旧

- 起動時の既定動作は cleanup-first です。以前のヘルパーは自動復元せず、削除または状態から消去します
- active stream のヘルパーは tmux / ワークツリー / 実行時状態 / 割当状態 / owner inbox 状態から除去されます
- 他リポジトリに属する非表示ヘルパー記録も、現在のリポジトリ側の状態には残さず消去します
- 将来 resume を足す場合でも、起動時の自動復元ではなくオペレーターの明示操作で行う想定です

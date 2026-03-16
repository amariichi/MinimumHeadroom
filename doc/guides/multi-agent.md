# Multi-Agent Guide

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

---

### Overview

minimum-headroom supports spawning helper coding agents in isolated worktrees, each with their own tmux pane, face tile, and permission configuration. The operator controls helpers from the browser UI or via MCP tools.

### Spawning Helpers

- **Desktop:** click the current-agent bar, open the Agents surface, then click **+Agent**
- **Mobile:** tap the current-agent bar, open the agent list, then tap **+Agent**
- **+Agent** uses auto-generated id, branch, and worktree defaults
- When the operator was started with `--repo`, helpers inherit that target repository
- Desktop renders the operator plus up to 7 helpers (8 tiles total)

### Permission Presets

`agent.spawn` accepts a `permission_preset` parameter (`reviewer`, `implementer`, `full`) to auto-configure tool permissions for the helper.

| Preset | Claude Code | Gemini CLI | Codex CLI |
|--------|-------------|------------|-----------|
| `reviewer` | Read, Glob, Grep, agent\_report (allow); no Bash | `read_file`, `search_files`, `list_files` | `-a untrusted` |
| `implementer` | + Edit, Write, Bash; deny `git push` | + `edit_file`, `write_file`, `run_shell_command` | `--full-auto` |
| `full` | same as `implementer` | same as `implementer` | `--full-auto` |

For detailed per-runtime setup, see:
- [Claude Code setup](../examples/claude-code/README.md)
- [Gemini setup](../examples/antigravity/README.md)
- [Codex setup](../examples/codex/config.toml)

### Mission Assignment and Delivery

- Store missions with `agent.assign`, specifying:
  - `role` — the helper's function (e.g. `reviewer`, `implementer`)
  - `target_paths` — files or directories the helper should focus on
  - `completion_criteria` — what counts as success
  - `timebox_minutes` — hard time bound for the current pass
  - `max_findings` — cap on findings before the helper should report back
- Deliver missions via `agent.inject` using controlled tmux paste-buffer injection
- Delivery is tracked through states: `pending` → `sent_to_tmux` → `acked` / `failed` / `timeout`
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

### Worktree Isolation and Security

- Each helper gets an isolated git worktree on its own branch
- `git push` is denied for all helper permission presets:
  - **Claude Code:** `deniedTools` includes `Bash(git push*)`
  - **Gemini / Codex:** constrained by agent instructions
- Settings files (e.g. `.claude/settings.json`) are set to `chmod 444` after write so helpers cannot modify their own permissions

### Deleting Helpers

- The **Delete** button removes the tmux pane, worktree, and runtime record together
- Via MCP: `agent.delete`

### Shutdown and Recovery

- After a full tmux shutdown, helpers are recreated from saved worktrees on next startup
- Only helpers from the active repository stream are restored
- Helpers whose worktrees are gone appear as `missing`
- Helpers from other repositories stay `hidden`

---

<a id="japanese"></a>
## 日本語

---

### 概要

minimum-headroom は、分離された worktree に helper コーディングエージェントを生成する機能を備えています。各 helper は独自の tmux ペイン、顔タイル、権限設定を持ちます。operator はブラウザ UI または MCP ツールから helper を制御します。

### Helper の生成

- **Desktop:** 現在エージェントバーをクリック → Agents サーフェス → **+Agent**
- **Mobile:** 現在エージェントバーをタップ → agent list → **+Agent**
- **+Agent** は自動生成の id / branch / worktree デフォルトを使用
- `--repo` 付きで operator を起動した場合、helper は target repository を継承
- Desktop は operator + helper 最大 7 体を同時表示（合計 8 タイル）

### 権限プリセット

`agent.spawn` で `permission_preset`（`reviewer` / `implementer` / `full`）を指定すると、ツール承認を自動設定します。

| プリセット | Claude Code | Gemini CLI | Codex CLI |
|--------|-------------|------------|-----------|
| `reviewer` | Read, Glob, Grep, agent\_report (allow); Bash なし | `read_file`, `search_files`, `list_files` | `-a untrusted` |
| `implementer` | + Edit, Write, Bash; `git push` を拒否 | + `edit_file`, `write_file`, `run_shell_command` | `--full-auto` |
| `full` | `implementer` と同一 | `implementer` と同一 | `--full-auto` |

各ランタイムの詳細設定:
- [Claude Code セットアップ](../examples/claude-code/README.md)
- [Gemini セットアップ](../examples/antigravity/README.md)
- [Codex セットアップ](../examples/codex/config.toml)

### ミッション割当と配信

- `agent.assign` でミッションを保存。指定可能なフィールド:
  - `role` — helper の役割（例: `reviewer`, `implementer`）
  - `target_paths` — helper が対象とするファイルやディレクトリ
  - `completion_criteria` — 成功の定義
  - `timebox_minutes` — 現在のパスの制限時間
  - `max_findings` — 報告前の findings 上限
- `agent.inject` で制御された tmux paste-buffer 注入により配信
- 配信状態は `pending` → `sent_to_tmux` → `acked` / `failed` / `timeout` で追跡
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

### Worktree 分離とセキュリティ

- 各 helper は独自ブランチ上の分離された git worktree を取得
- `git push` は全プリセットで拒否:
  - **Claude Code:** `deniedTools` に `Bash(git push*)` を含む
  - **Gemini / Codex:** エージェント指示で制約
- 権限設定ファイル（例: `.claude/settings.json`）は書き込み後 `chmod 444` で保護され、helper が自身の権限を変更できない

### Helper の削除

- **Delete** ボタンで tmux ペイン、worktree、runtime record をまとめて削除
- MCP 経由: `agent.delete`

### シャットダウンと復旧

- tmux session 全体の停止後、次回起動時に worktree が残っていれば helper を再生成
- active repository stream の helper のみ復元
- worktree がない helper は `missing` として表示
- 他 repository の helper は `hidden` のまま

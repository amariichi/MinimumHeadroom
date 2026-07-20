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

### Active Stream and Cross-Repository Work

A stream groups one user-visible task under one owner. It controls browser
visibility, mission assignment, and the owner inbox; it is not a Git repository
or filesystem boundary. `source_repo_path`, `target_repo_root`, worktrees,
permission presets, and `target_paths` control where a helper works.

The operator launcher derives the active stream from its `--repo` target, and
the browser shows only helpers in that active stream. `session_id` groups
conversation or signaling events and does not affect this visibility.

`agent.spawn` uses the active stream when `stream_id` is omitted, including
when the helper works in another repository. An explicitly different
`stream_id` is still accepted, but the result contains
`visible_in_active_stream=false` and a warning that the helper is outside the
authoritative active-stream list. Activity signaling from that helper can
still surface a provisional browser tile. The browser reports how many
registered helpers are outside the active stream without treating them as
normal managed helpers in the active owner lifecycle.

For a helper that belongs to the current user task:

1. Call `agent.list(scope="stream")` and retain its `active_stream_id`.
2. Omit `stream_id` at spawn or pass that exact active value. If the helper
   works in another repository, set `source_repo_path` and `target_repo_root`
   separately and use absolute `target_paths` in the mission.
3. After spawn, require `visible_in_active_stream=true` and confirm the helper
   appears in another `agent.list(scope="stream")` result.

Use a different stream only for a genuinely independent user task or owner
lifecycle. If `agent.list(scope="all")` contains a helper that the stream-scoped
list does not, delete and recreate it in the active stream unless that
separation was intentional.

### Permission Presets

`agent.spawn` accepts a `permission_preset` parameter (`reviewer`, `implementer`, `full`) to auto-configure tool permissions for the helper.

For Claude Code, Antigravity CLI, and Codex CLI, these presets complement the runtime's own setup. They do not replace project-local agent instructions such as `AGENTS.md` or signaling rules like `doc/examples/AGENT_RULES.md`.

| Preset | Claude Code | Antigravity CLI | Codex CLI |
|--------|-------------|------------|-----------|
| `reviewer` | Read, Glob, Grep, agent\_report (allow); no Bash | sandboxed read-oriented command allow-list | `-s read-only -a never` |
| `implementer` | + Edit, Write, Bash; deny `git push` | sandboxed commands, deny direct `git push` command forms, append `--dangerously-skip-permissions` | `-s workspace-write -a never --add-dir <sourceRepo>/.git` |
| `full` | same as `implementer` | same as `implementer` | `--dangerously-bypass-approvals-and-sandbox` |

Antigravity presets are session-scoped: all launch with `--sandbox`, and the
helper process receives `MH_AGY_PERMISSION_PRESET`. Spawn also creates a
worktree-local plugin under
`.agents/plugins/minimum-headroom-helper-policy/`; that plugin runs
`scripts/agy-helper-policy.mjs` before terminal commands. It allows the
reviewer read-command subset, forces review for other reviewer commands, and
denies direct `git push` for every helper preset. The global/operator plugin
does not contain this `PreToolUse` hook, so normal interactive agy sessions are
unaffected.

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
- Generated settings/plugin files where used (currently Claude Code and Antigravity) are set to `chmod 444` after write so helpers cannot modify their own permissions

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

minimum-headroom は、分離されたワークツリーへ補助のコーディングエージェントを生成できます。
各ヘルパーは、専用の tmux ペイン、顔タイル、権限設定を持ちます。オペレーターは、ブラウザ
画面または MCP ツールからヘルパーを制御します。

minimum-headroom のオペレーター／ヘルパー実行環境を使う場合は、`minimum-headroom-ops`
スキルも導入してください。オペレーター主導の処理で使う、標準 MCP ライフサイクルと
ヘルパーレポートの規約をまとめています。

### ヘルパーの生成

- **デスクトップ:** 現在のエージェントを示すバーをクリックし、`Agents` 画面で **+Agent** を
  選びます。
- **モバイル:** 現在のエージェントを示すバーをタップし、エージェント一覧で **+Agent** を
  選びます。
- **+Agent** は、`helper-1`、`helper-2` のような読みやすい ID と、ブランチ／ワークツリーの
  既定値を自動生成します。
- `--repo` を指定してオペレーターを起動した場合、ヘルパーは対象リポジトリを引き継ぎます。
- デスクトップには、オペレーターと最大7体のヘルパーを同時に表示できます（合計8タイル）。
- MCP の `agent.spawn` では、ヘルパー名の標準フィールドは `id` です。互換用の別名として、
  `agent_id` も受け付けます。

### Active stream とリポジトリを跨ぐ作業

stream は、一人のオーナーが担当する一つのユーザー作業をまとめる単位です。ブラウザでの表示、
ミッション割当、owner inbox の範囲を決めますが、Git リポジトリやファイルアクセスの境界では
ありません。ヘルパーが実際に作業する場所は、`source_repo_path`、`target_repo_root`、
ワークツリー、権限プリセット、`target_paths` で決まります。

オペレーターの起動スクリプトは、`--repo` の対象から active stream を決めます。ブラウザに
表示されるのは、この active stream に属するヘルパーだけです。`session_id` は会話や通知を
まとめる識別子であり、ブラウザの表示には影響しません。

`agent.spawn` で `stream_id` を省略すると、別リポジトリで作業する場合も active stream を
使います。別の `stream_id` を明示することもできますが、結果には
`visible_in_active_stream=false` と、active stream の正式な一覧には含まれないという警告が
含まれます。そのヘルパーから動作通知が届いた場合は、一時的な provisional タイルがブラウザに
表示されることがあります。ブラウザには active stream 外の登録済みヘルパー数も示しますが、
active stream の通常の管理対象としては扱いません。

現在のユーザー作業に属するヘルパーは、次の手順で生成します。

1. `agent.list(scope="stream")` を呼び、返された `active_stream_id` を控えます。
2. 生成時は `stream_id` を省略するか、控えた active stream ID をそのまま渡します。
   別リポジトリで作業させる場合は、`source_repo_path` と `target_repo_root` を別途指定し、
   ミッションの `target_paths` には絶対パスを使います。
3. 生成結果が `visible_in_active_stream=true` であることと、再度呼んだ
   `agent.list(scope="stream")` にヘルパーが含まれることを確認します。

別の stream を使うのは、独立したユーザー作業として扱う場合や、オーナーのライフサイクルを
分ける場合だけです。`agent.list(scope="all")` には存在するのに stream 単位の一覧に出ない
ヘルパーは、その分離が意図したものでなければ削除し、active stream で作り直してください。

### 権限プリセット

`agent.spawn` で `permission_preset`（`reviewer` / `implementer` / `full`）を指定すると、
ツールの承認設定を自動的に構成します。

Claude Code、Antigravity CLI、Codex CLI のいずれでも、これらのプリセットは各実行環境の
セットアップを補うものであり、置き換えるものではありません。プロジェクト内の `AGENTS.md` や
`doc/examples/AGENT_RULES.md` など、エージェント向けの指示も設定してください。

| プリセット | Claude Code | Antigravity CLI | Codex CLI |
|--------|-------------|------------|-----------|
| `reviewer` | Read、Glob、Grep、agent\_report を許可。Bash は不可 | サンドボックス内で読み取り向けコマンドだけを許可 | `-s read-only -a never` |
| `implementer` | Edit、Write、Bash も許可し、`git push` は拒否 | サンドボックス内のコマンドを許可し、直接の `git push` を拒否。`--dangerously-skip-permissions` を追加 | `-s workspace-write -a never --add-dir <sourceRepo>/.git` |
| `full` | `implementer` と同一 | `implementer` と同一 | `--dangerously-bypass-approvals-and-sandbox` |

Antigravity のプリセットはセッション単位です。すべて `--sandbox` で起動し、ヘルパーの
プロセスへ `MH_AGY_PERMISSION_PRESET` を渡します。ヘルパーを生成するときには、
`.agents/plugins/minimum-headroom-helper-policy/` にワークツリー専用のプラグインも作成します。

このプラグインの `scripts/agy-helper-policy.mjs` は、`reviewer` プリセットでは読み取り向けの
コマンドだけを許可し、それ以外のコマンドには確認を求めます。また、すべての
ヘルパープリセットで直接の `git push` を拒否します。グローバルまたはオペレーター用の
プラグインには、この `PreToolUse` フックを追加しません。そのため、通常の対話型 agy には
影響しません。

Codex のプリセット末尾引数は、以下の環境変数で丸ごと置き換えできます。

- `MH_CODEX_PRESET_REVIEWER`
- `MH_CODEX_PRESET_IMPLEMENTER`
- `MH_CODEX_PRESET_FULL`

Codex コマンドが `-s read-only` または `-s workspace-write` を要求する場合は、ヘルパーを
生成するときに、サーバープロセスごとに一度だけ
`timeout 15 codex sandbox -- echo __mh_userns_ok__` を実行します。これは、サンドボックスが
利用できるかを事前に確認する処理です。

確認用トークンが見つからなければ、そのサンドボックスモードを `-s danger-full-access` へ
切り替えます。生成結果には `sandbox_fallback: true` と理由を含め、ヘルパーの状態メッセージ
にも権限を緩和した理由を残します。ユーザー名前空間が制限されたホストで、コマンドを実行
できない Codex ヘルパーを理由も示さず作成しないためです。

tmux ペインを作成した後、CLI が実際に起動したかを確認します。約15秒間
`pane_current_command` を確認し続け、`bash`、`zsh`、`sh`、`dash`、`fish` などの素のシェルの
ままなら `launch_failed` として扱います。ヘルパーの記録は調査用に残し、生成結果には直前の
ペイン末尾も含めます。これにより、オペレーターが起動失敗の原因を確認できます。

各実行環境の詳しい設定:

- [Claude Code セットアップ](../examples/claude-code/README.md)
- [Antigravity セットアップ](../examples/antigravity/README.md)
- [Codex セットアップ](../examples/codex/config.toml)

Antigravity CLI のヘルパーでは、権限プリセットを使っても、初回だけ対話操作が必要になることが
あります。新しく生成したワークツリーでは、ミッションを注入する前に、ワークスペースの信頼を
確認する画面が表示される場合があります。最初の MCP ツール呼び出しでも、会話単位の承認を
求められることがあります。生成したヘルパーワークツリーを信頼し、少なくとも
`minimum_headroom/agent_report` を許可してください。ヘルパーがフェイスツールを使う場合は、
`face_ping`、`face_event`、`face_say` についても、個別に承認を求められることがあります。

### ミッション割当と配信

- `agent.assign` でミッションを保存します。次のフィールドを指定できます。
  - `role` — ヘルパーの役割（例: `reviewer`、`implementer`）
  - `target_paths` — ヘルパーが対象とするファイルやディレクトリ
  - `completion_criteria` — 成功の定義
  - `timebox_minutes` — 現在の作業単位の制限時間
  - `max_findings` — 一度に報告する指摘の上限
- `agent.inject` は、tmux のペーストバッファを制御してミッションを配信します。
- 配信状態は、`pending` → `sent_to_tmux` → `acked` / `failed` / `timeout` の順で追跡します。
- 受領確認のタイムアウトは、既定で120秒です。起動に時間のかかる CLI が読み込みを終える前に、
  タイムアウトと判断されることを防ぎます。
- ペインで動いているのが素のシェルの場合、`agent.inject` はミッション文の貼り付けを拒否し、
  `injection_refused_shell_pane` と短いペイン末尾を返します。シェルの復旧操作として意図的に
  入力する場合だけ、`force_shell_inject: true` を指定してください。
- 配信状態と受領確認は、`agent.assignment.list` で確認できます。
- 対応する `agent.report` がヘルパーから届くと、受領済みと判断します。

### ヘルパーレポートとオーナー受信箱

- ヘルパーは `agent.report` で、次の種別を報告します。
  - `progress` — 作業中。最初のレポートは、ミッションを受諾したことを示します
  - `blocked` — オーナーの操作なしでは続行できない状態
  - `question` — 確認が必要
  - `done` — ミッション完了
  - `review_findings` — レビュー結果の提出
- レポートは永続化されたオーナー受信箱（owner inbox）へ保存され、ブラウザを再読み込みしても
  残ります。
- 対応を終えたレポートは、`owner.inbox.resolve` で解決済みにします。
- 未解決の項目がある間は、UI 上でヘルパーとオーナーへの注意表示を維持します。

### フォーカスとリターゲット

- タイルまたは一覧の行をクリック／タップすると、オペレーターの接続先を切り替えられます。
- `agent.focus` は表示だけを変更し、作業の所有権は変更しません。
- ヘルパーへフォーカスしても、ユーザーと直接対話する権限は移りません。ユーザーへ話しかける
  のは、オペレーターだけです。

### 停止検出とペイン制御

ヘルパーは、ツールの承認画面、モデル選択画面、利用上限の通知、CLI のアンケートなど、
CLI のモーダル画面で停止することがあります。この状態では、内側の LLM は入力を読みません。
注入したミッション文はモデルへ届かず、`agent.assignment.list` には
`delivery_state=timeout` と表示されるだけなので、原因を判断できません。どの MCP クライアント
からでも状態を確認して復旧できるよう、実行環境は次の3つの仕組みを備えています。

- バックグラウンドの **停止検出器** が face-app 内で動きます。確認間隔の既定値は5秒で、
  `MH_HELPER_STUCK_DETECTOR=off` を指定すると無効になります。確認のたびに、動作中の全ヘルパー
  からペイン末尾を取得し、`Do you want to proceed?`、`Switch to gpt-…`、
  `You've hit your usage limit`、`How's the CLI experience`、`Press enter to confirm` など、
  少数の既知パターンと照合します。新しい一致を見つけると、`kind=blocked` のレポートを
  オーナー受信箱へ送り、一致した行と周辺のペイン内容を `detail` に含めます。同じ
  `(agent, pattern, matched line)` は約30秒間重複を除外するため、受信箱が同じ通知で
  埋まりません。
- **`agent.pane_snapshot { agent_id, tail_lines? }`** は、ヘルパーのペイン末尾から N 行を返します
  （既定40行、最大400行）。ANSI 制御文字は除去されます。受信箱の `blocked` レポートが示す
  ヘルパーについて、モーダルの本文を確認してから対応を決めるために使います。
- **`agent.pane_send_key { agent_id, keys, literal? }`** は、ヘルパーのペインへ tmux のキー入力を
  直接送ります。`keys` には、印字可能な ASCII（`"2"`、`"hello world"`）と、名前付きキーの
  許可リスト（`Enter`、`Escape`、`Tab`、`BSpace`、`Space`、`Up`、`Down`、`Left`、`Right`、
  `Home`、`End`、`PageUp`、`PageDown`、`C-c`、`C-m`、`C-d`）を指定できます。
  `literal: true` を指定すると、tmux へ `-l --` を渡し、入力を文字列として扱います。CLI の
  選択画面へ自由入力する場合に向いています。このツールは **CLI のモーダルへ応答するため**の
  もので、ミッションの配信には使いません。ミッションは `agent.inject` で配信してください。

典型的な復旧手順:

1. オーナー受信箱に `{kind: "blocked", summary: "helper paused on approval prompt", from_agent_id: "helper-1"}`
   または `"... on model picker"` などのレポートが現れます。
2. `agent.pane_snapshot agent_id=helper-1 tail_lines=30` でモーダルの本文を確認します。
3. 適切な応答を選び、番号で選ぶ画面なら
   `agent.pane_send_key agent_id=helper-1 keys=["2","Enter"]`、矢印で選ぶ画面なら
   `keys=["Down","Enter"]` を送ります。
4. 必要に応じて、もう一度 `agent.pane_snapshot` を呼び、モーダルが閉じたことを確認します。
   モーダルが入力を受け取っていた間にミッション文が失われた場合は、`agent.inject` で
   再送します。
5. 自動生成された `blocked` レポートを、`owner.inbox.resolve action=resolved` で解決済みに
   します。

検出器はレポートを送るだけで、キーを自動的に押すことはありません。どの応答を送るかは、
オペレーターまたはユーザーが判断します。これにより、正規表現に一致しただけで
`No, and always deny` のような取り返しのつかない選択肢を実行することを防ぎます。

### ワークツリーの分離とセキュリティ

- 各ヘルパーには、専用ブランチ上の分離された Git ワークツリーを割り当てます。
- ミッションの `target_paths` は、作業ストリームのルートを基準にした読み取り対象です。
  ヘルパーは、元リポジトリのチェックアウトではなく、割り当てられたワークツリー上の
  ヘルパーブランチで編集とコミットを行います。
- ヘルパーによる公開操作の制御方法は、実行環境ごとに異なります。
  - **Claude Code:** `deniedTools` に `Bash(git push*)` を含む
  - **Antigravity:** `agy-helper-policy.mjs` が、直接的な `git push` コマンドに対して
    `PreToolUse` の拒否判定を返します。これはコマンド文字列に対する安全策であり、難読化した
    シェルコマンドを防ぐセキュリティ境界ではありません。
  - **Codex:** エージェント向けの指示で制約します。技術的な拒否規則はありません。
- 生成した権限設定／プラグインファイル（現在は Claude Code と Antigravity）は、書き込み後に
  `chmod 444` で保護します。ヘルパーは自身の権限を変更できません。

### ヘルパーの削除

- **Delete** ボタンは、tmux ペイン、ワークツリー、実行時記録、ミッション記録、オーナー
  受信箱の記録をまとめて削除します。
- MCP から削除する場合は、`agent.delete` を使います。

### シャットダウンと復旧

- 起動時は、後始末を優先します。以前のヘルパーを自動復元せず、削除するか状態記録から
  取り除きます。
- 現在の作業ストリームに属するヘルパーは、tmux、ワークツリー、実行時状態、ミッション状態、
  オーナー受信箱から取り除きます。
- 別のリポジトリに属する非表示のヘルパー記録も、現在のリポジトリ側の状態には残しません。
- 将来、再開機能を追加する場合も、起動時に自動復元するのではなく、オペレーターの明示的な
  操作で再開する想定です。

# Hook bridge configuration

[English](#english) | [日本語](#japanese)

<a id="english"></a>

## English

This directory contains example configuration snippets that wire each supported
agent runtime's hook system to `scripts/mh-hook.mjs`. The wrapper translates a
canonical hook event (`permission_required` or `idle_after_response`) into a
`face_say` + `face_event` and, for helper agents, an owner-inbox entry — even
when the agent forgets to call `face_say` voluntarily.

### Runtime coverage

This bridge covers all three supported agent runtimes:

- **Claude Code**: `Notification`, `Stop`, and optional `UserPromptSubmit`
  situation injection through the example settings file.
- **Codex CLI**: `PermissionRequest`, `UserPromptSubmit`, and `Stop` through the
  hook system, plus a legacy `notify` fallback. Codex additionally requires a
  one-time hook trust grant, documented below.
- **Antigravity CLI / agy**: JSON hooks for `Stop`, with a disabled
  `PreToolUse` approval-attention example.

The Codex section is longer because Codex has an extra trust model; it is not
the only runtime supported by this directory.

### Files

- `claude-settings.json.example` — paste into `~/.claude/settings.json` (merge
  with existing `hooks` block). Wires Claude Code's `Notification` and `Stop`
  events, and optionally injects the M12 situation digest through
  `UserPromptSubmit`.
- `codex-config.toml.example` — paste into `~/.codex/config.toml`. Wires the new
  Codex `hooks` system (`PermissionRequest`, `UserPromptSubmit`, and `Stop`) and
  keeps the legacy `notify` line as a fallback.
- `antigravity-hooks.json.example` — copy into an Antigravity `hooks.json`. Wires `Stop` and includes a disabled `PreToolUse` approval-attention example.

### Codex-specific: trust grant required (one time, user-level)

Codex (verified against rust-v0.130.0 and main branch as of 2026-05-10) treats every user-defined hook as **untrusted** until the user explicitly approves it. Untrusted hooks are silently filtered out at startup — they will not fire even when the config is correct.

The trust is **per-user, persistent, and inherited by every subsequent Codex process** (including helpers spawned by `agent.spawn`). You only need to do it once after editing `~/.codex/config.toml`. You do **not** need to enter individual helper panes or repeat per-session.

After editing the `[[hooks.*]]` blocks in `~/.codex/config.toml`, do one of:

**Automated (recommended):** run the bundled helper from a shell with `tmux` and `codex` on PATH:

    ./scripts/grant-codex-hook-trust.sh

It spawns Codex inside a private tmux server, opens the `/hooks` lifecycle browser, walks each event group, presses `t` to trust the visible hook, then exits. Watches `~/.codex/config.toml` for newly written `[hooks.state.*]` entries and prints `trust granted` on success. Idempotent: a re-run with no untrusted hooks remaining exits cleanly with "nothing to trust".

**Manual:** run `codex` interactively and follow the banner that says "*N hooks need review. Open /hooks to review them.*":

1. Type `/hooks` and submit (Tab to accept the slash-command, then Enter).
2. Press Enter on the first event row that shows a `1 / 1` pending count.
3. Press `t` to trust the visible hook.
4. Press Esc to go back to the events list, navigate to the next event with pending hooks, repeat.
5. Esc to close the browser, then `/quit`.

Either way Codex writes a SHA-256 hash under `[hooks.state.<key>]` in `~/.codex/config.toml`. From that point on every Codex session for that user — operator and every helper — will execute the hooks. Re-grant only when you change a hook's command or matcher (the hash is identity-based; editing the command invalidates the stored hash).

Note: the feature flag is `[features] hooks = true`. Codex < 0.131 also accepts the deprecated alias `codex_hooks = true` with a startup warning. For optional M12 situation digest injection, use `scripts/situation-context-hook-codex.mjs`; it returns `UserPromptSubmit.hookSpecificOutput.additionalContext` JSON around the plain text produced by `scripts/situation-context-hook.sh`. (Antigravity has an equivalent wrapper, `scripts/situation-context-hook-agy.mjs`, registered as a `PreInvocation` hook.)

Source: `codex-rs/hooks/src/engine/discovery.rs` (`HookTrustStatus` filter), `codex-rs/tui/src/bottom_pane/hooks_browser_view.rs` (`t` keymap), and `codex-rs/features/src/legacy.rs` (alias) in <https://github.com/openai/codex>.

### Common prerequisites

- The face-app and MCP server must be running (the operator stack does both).
  Without them, the wrapper exits silently with a stderr note and the agent
  runtime continues normally.
- `MH_FACE_AGENT_ID` must be exported in the agent's process environment.
  `scripts/run-bound-mcp-server.sh` already sets this for normally-spawned
  helpers; for the operator agent it is set by `scripts/run-operator-once.sh`.
- Replace `/abs/path/to/scripts/mh-hook.mjs` in every example with the absolute
  path to `scripts/mh-hook.mjs` in your clone.
- The Claude `UserPromptSubmit` situation hook only emits context when the
  launched process has `MH_SITUATION_INJECT=1`. Set `VISION_BASE_URL` only if
  your vision worker is not at `http://127.0.0.1:8095`.
- Templates (the lines spoken on each event) live at
  `~/.minimum-headroom/face-templates.json`. If the file is absent, the
  built-in defaults (Japanese + English) are used.

### Output discipline

`mh-hook.mjs` always exits `0`. For Claude Code and Codex it writes nothing to stdout, preserving their hook contracts. Claude's M12 `UserPromptSubmit` context, when enabled, comes from `scripts/situation-context-hook.sh`, not from `mh-hook.mjs`. For Antigravity CLI, `--runtime antigravity` writes the minimal JSON that Antigravity expects for `PreToolUse` and `Stop` hooks while still forwarding the face hook payload.

This is required because:

- Antigravity hooks use stdout JSON for flow control on events such as `PreToolUse` and `Stop`.
- Claude Code and Codex hooks should not receive stray stdout from a safety-net hook.
- Codex hooks treat exit `2` as a generic block, so the wrapper must never exit non-zero.

If you customize the wrapper, preserve these invariants.

### Templates file

Example `~/.minimum-headroom/face-templates.json`:

    {
      "permission_required": {
        "ja": ["承認をお願いします。", "確認お願いします。", "もう一度承認お願いします。"],
        "en": ["Approval needed.", "One more approval, please.", "Approval needed to continue."]
      },
      "idle_after_response": {
        "ja": ["作業が止まっているかもしれません。", "応答待ちかもしれません。"],
        "en": ["I may be stuck waiting.", "Turn ended; awaiting next step."]
      }
    }

The face-app picks a variant from the array, avoiding the most recently spoken
line for the same `(agent_id, event)` pair. Language is detected from the
agent's recent `face_say` history (CJK characters → `ja`, otherwise → `en`),
falling back to `MH_FACE_LANG` when the agent has not spoken yet.

---

<a id="japanese"></a>

## 日本語

このディレクトリには、Claude Code、Codex、Antigravity CLI のフック機構を
`scripts/mh-hook.mjs` へ接続するための設定例があります。このラッパーは、共通形式の
フックイベント（`permission_required` または `idle_after_response`）を `face_say` と
`face_event` に変換します。ヘルパーからのイベントなら、オーナーの受信箱（owner inbox）
にも通知します。エージェント自身が `face_say` を呼び忘れたときの安全網です。

### 対応する実行環境

このブリッジは、次の3種類のエージェント実行環境に対応します。

- **Claude Code**: 設定例を使って `Notification` と `Stop` を接続します。必要なら、
  `UserPromptSubmit` で周囲状況も注入できます。
- **Codex CLI**: `PermissionRequest`、`UserPromptSubmit`、`Stop` を新しいフック機構へ接続し、
  従来の `notify` も予備経路として残します。Codex ではユーザー単位の信頼許可が一度だけ
  必要なため、後述の説明がほかより長くなっています。
- **Antigravity CLI / agy**: `Stop` 用の JSON フックと、既定では無効な
  `PreToolUse` 承認通知の例を提供します。

Codex の説明が長いのは信頼モデルが異なるためで、このディレクトリが Codex 専用だからでは
ありません。

### 同梱ファイル

- `claude-settings.json.example` — 既存の `hooks` ブロックと統合して
  `~/.claude/settings.json` に設定します。Claude Code の `Notification` と `Stop` を接続し、
  必要なら `UserPromptSubmit` で M12 の状況要約を注入します。
- `codex-config.toml.example` — `~/.codex/config.toml` に追記します。Codex の新しい
  `hooks` 機構（`PermissionRequest`、`UserPromptSubmit`、`Stop`）を接続し、互換性のために
  従来の `notify` を予備経路としてコメント付きで残します。
- `antigravity-hooks.json.example` — Antigravity の `hooks.json` として使います。
  `Stop` と、既定では無効な `PreToolUse` 承認通知の例を含みます。

### Codex 固有：信頼許可はユーザーごとに一度だけ

Codex（rust-v0.130.0 と main を 2026-05-10 時点で検証）は、ユーザーが定義したフックを
明示的に許可するまで **untrusted** として扱い、起動時に通知なく除外します。設定が正しくても、
信頼を許可しなければフックは動きません。

信頼状態はユーザー単位で `~/.codex/config.toml` の `[hooks.state.*]` に保存されます。
**以後、同じユーザーで起動するすべての Codex プロセスへ自動的に引き継がれます。**
オペレーターが生成したヘルパーも対象です。ヘルパーのペインを一つずつ開いて許可する必要は
ありません。

`~/.codex/config.toml` の `[[hooks.*]]` ブロックを編集したら、次のどちらかを実行します。

**自動（推奨）：** `tmux` と `codex` に `PATH` が通ったシェルで、同梱スクリプトを実行します。

    ./scripts/grant-codex-hook-trust.sh

スクリプトは、ほかのセッションから分離した一時的な tmux サーバー内で Codex を起動します。
続いて `/hooks` 画面の各イベントグループを Enter → `t`（信頼を許可）→ Esc の順に巡回し、
`[hooks.state.*]` が書き込まれたら自動終了します。繰り返し実行しても安全です。すべて許可済み
なら、`nothing to trust` と表示して正常終了します。

**手動：** `codex` を通常どおり起動し、画面上部の
「*N hooks need review. Open /hooks to review them.*」という案内に従います。

1. `/hooks` と入力し、Tab でスラッシュコマンドを確定してから Enter で送信します。
2. `1 / 1` と表示されているイベント行で Enter を押し、そのイベントの Handlers ページへ
   移動します。
3. `t` キーを押して、表示中のフックを信頼済みにします。
4. Esc でイベント一覧へ戻り、未許可のフックがある次のイベント行でも同じ操作を繰り返します。
5. Esc で画面を閉じ、`/quit` で Codex を終了します。

どちらの方法でも、Codex は `[hooks.state.<key>]` に SHA-256 ハッシュを書き込みます。フックの
command や matcher を**編集すると**ハッシュが変わり、再び untrusted になります。その場合だけ、
信頼許可をやり直してください。

機能フラグは `[features] hooks = true` です。Codex 0.131 未満では、非推奨の別名
`codex_hooks = true` も使えますが、起動時に警告が出ます。M12 の状況要約を注入する場合は
`scripts/situation-context-hook-codex.mjs` を使ってください。このラッパーは、
`scripts/situation-context-hook.sh` が出力したプレーンテキストを
`UserPromptSubmit.hookSpecificOutput.additionalContext` の JSON に包んで返します。
Antigravity では、同等の `scripts/situation-context-hook-agy.mjs` を `PreInvocation` フックとして
登録します。

根拠となる実装は、`codex-rs/hooks/src/engine/discovery.rs`（`HookTrustStatus` フィルター）、
`codex-rs/tui/src/bottom_pane/hooks_browser_view.rs`（`t` キーの割り当て）、
`codex-rs/features/src/legacy.rs`（別名の定義）です。<https://github.com/openai/codex>

### 共通の前提

- face-app と MCP サーバーが起動していること。オペレータースタックは両方を起動します。
  起動していなくても、ラッパーは標準エラーへ1行だけ記録して終了コード 0 で終わるため、
  エージェント実行環境は停止しません。
- エージェントプロセスの環境変数に `MH_FACE_AGENT_ID` が設定されていること。
  `scripts/run-bound-mcp-server.sh` はヘルパー用に、`scripts/run-operator-once.sh` は
  オペレーター用に、それぞれ設定します。
- 設定例の `/abs/path/to/scripts/mh-hook.mjs` を、手元のクローンにある
  `scripts/mh-hook.mjs` の絶対パスへ置き換えること。
- Claude の `UserPromptSubmit` 状況フックは、起動したプロセスに
  `MH_SITUATION_INJECT=1` が設定されている場合だけ文脈を出力します。vision worker が
  `http://127.0.0.1:8095` 以外で動く場合だけ、`VISION_BASE_URL` も設定してください。
- 発話テンプレートは `~/.minimum-headroom/face-templates.json` に置けます。ファイルがなければ、
  組み込みの日本語・英語テンプレートを使います。

### 出力規律（重要）

`mh-hook.mjs` は、**どの経路でも終了コード 0** で終わります。Claude Code と Codex では、
標準出力へ何も書きません。Claude の M12 `UserPromptSubmit` 文脈注入は、`mh-hook.mjs` ではなく
`scripts/situation-context-hook.sh` が担当します。Antigravity CLI では
`--runtime antigravity` を指定したときだけ、`PreToolUse` と `Stop` が必要とする最小限の JSON を
標準出力へ返しながら、フェイス用のフック情報を転送します。

理由：

- Antigravity のフックは、`PreToolUse` と `Stop` の処理制御に標準出力の JSON を使います。
- Claude Code と Codex では、安全網となるフックが余計な標準出力を返してはいけません。
- Codex のフックは終了コード `2` をブロックとして扱うため、ラッパーは 0 以外で終了しては
  いけません。

ラッパーを変更する場合も、これらの条件を維持してください。

### テンプレートファイル

`~/.minimum-headroom/face-templates.json` の例：

    {
      "permission_required": {
        "ja": ["承認をお願いします。", "確認お願いします。", "もう一度承認お願いします。"],
        "en": ["Approval needed.", "One more approval, please.", "Approval needed to continue."]
      },
      "idle_after_response": {
        "ja": ["作業が止まっているかもしれません。", "応答待ちかもしれません。"],
        "en": ["I may be stuck waiting.", "Turn ended; awaiting next step."]
      }
    }

face-app は、同じ `(agent_id, event)` の組み合わせでは直前と異なる候補を優先します。
言語はエージェントの直近の `face_say` 履歴から自動判定します。CJK 文字を含めば `ja`、
それ以外は `en` です。まだ発話履歴がなければ、環境変数 `MH_FACE_LANG` を使います。

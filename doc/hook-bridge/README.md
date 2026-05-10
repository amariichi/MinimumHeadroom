# Hook bridge configuration

This directory contains example configuration snippets that wire each supported
agent runtime's hook system to `scripts/mh-hook.mjs`. The wrapper translates a
canonical hook event (`permission_required` or `idle_after_response`) into a
`face_say` + `face_event` and, for helper agents, an owner-inbox entry — even
when the agent forgets to call `face_say` voluntarily.

## Files

- `claude-settings.json.example` — paste into `~/.claude/settings.json` (merge
  with existing `hooks` block). Wires Claude Code's `Notification` and `Stop`
  events.
- `codex-config.toml.example` — paste into `~/.codex/config.toml`. Wires the new
  Codex `hooks` system (`PermissionRequest` + `Stop`) and keeps the legacy
  `notify` line as a fallback.
- `gemini-settings.json.example` — paste into `~/.gemini/settings.json`. Wires
  Gemini CLI's `Notification` and `AfterAgent` events.

## Codex-specific: trust grant required (one time, user-level)

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

Note: the feature flag is `[features] hooks = true`. Codex < 0.131 also accepts the deprecated alias `codex_hooks = true` with a startup warning.

Source: `codex-rs/hooks/src/engine/discovery.rs` (`HookTrustStatus` filter), `codex-rs/tui/src/bottom_pane/hooks_browser_view.rs` (`t` keymap), and `codex-rs/features/src/legacy.rs` (alias) in <https://github.com/openai/codex>.

## Common prerequisites

- The face-app and MCP server must be running (the operator stack does both).
  Without them, the wrapper exits silently with a stderr note and the agent
  runtime continues normally.
- `MH_FACE_AGENT_ID` must be exported in the agent's process environment.
  `scripts/run-bound-mcp-server.sh` already sets this for normally-spawned
  helpers; for the operator agent it is set by `scripts/run-operator-once.sh`.
- Replace `/abs/path/to/scripts/mh-hook.mjs` in every example with the absolute
  path to `scripts/mh-hook.mjs` in your clone.
- Templates (the lines spoken on each event) live at
  `~/.minimum-headroom/face-templates.json`. If the file is absent, the
  built-in defaults (Japanese + English) are used.

## Output discipline

`mh-hook.mjs` is hard-wired to write nothing to stdout and exit `0` under all
conditions, including failures. This is required because:

- Gemini CLI parses hook stdout as JSON; any stray bytes corrupt the parse.
- Gemini's `AfterAgent` interprets exit code `2` as "retry this turn with
  stderr as the new prompt" — exiting non-zero from a safety-net hook would
  silently kick the agent into an unwanted retry loop.
- Codex hooks treat exit `2` as a generic block.

If you customise the wrapper, preserve these invariants.

## Templates file

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

## 日本語

このディレクトリには、各 agent runtime（Claude Code / Codex / Gemini CLI）の hook 機構を `scripts/mh-hook.mjs` に配線するための設定例が入っています。wrapper は canonical な hook event（`permission_required` または `idle_after_response`）を `face_say` + `face_event`、helper の場合はさらに owner inbox エントリに変換します。agent 自身が `face_say` を呼び忘れたときの安全網。

### 同梱ファイル

- `claude-settings.json.example` — `~/.claude/settings.json` にマージ。Claude Code の `Notification` / `Stop` イベントを配線。
- `codex-config.toml.example` — `~/.codex/config.toml` に追記。Codex の新 `hooks` 系（`PermissionRequest` + `Stop`）を配線。互換のため legacy `notify` フォールバック行もコメント付きで掲載。
- `gemini-settings.json.example` — `~/.gemini/settings.json` にマージ。Gemini CLI の `Notification` / `AfterAgent` イベントを配線。

### Codex 固有：trust 付与は1回だけ・user 単位・helper にも自動継承

Codex（rust-v0.130.0 と main を 2026-05-10 時点で検証）は user 定義の hook を起動時に **untrusted** 扱いし、silent に filter out します。設定が正しくても trust 付与なしでは hook は発火しません。

trust は user 単位で `~/.codex/config.toml` の `[hooks.state.*]` に永続化され、**同じユーザーで起動する以降の全 codex プロセスに自動継承されます（operator が spawn した helper も含む）**。helper の pane に毎回入って trust 操作する必要はありません。1回付与すれば全ヘルパーで効きます。

`~/.codex/config.toml` の `[[hooks.*]]` ブロックを編集したら、次のいずれかを実行：

**自動（推奨）：** `tmux` と `codex` が PATH にあるシェルで同梱スクリプトを実行：

    ./scripts/grant-codex-hook-trust.sh

裏で短命 codex を private tmux server に立ち上げ、`/hooks` ブラウザを開いて各 event group を Enter → `t`（trust） → Esc で巡回し、`[hooks.state.*]` が書き込まれたら自動終了します。idempotent なので、すべて trust 済みなら "nothing to trust" で正常終了。

**手動：** `codex` を普通に起動し、画面上部の「*N hooks need review. Open /hooks to review them.*」バナーに従って：

1. `/hooks` と入力 → Tab でスラッシュコマンド確定 → Enter で送信。
2. `1 / 1` と表示されている event 行で Enter（その event の Handlers ページに遷移）。
3. `t` キーで表示中の hook を trust。
4. Esc で events 一覧に戻り、次に未 trust のある event 行へカーソル移動、繰り返し。
5. Esc でブラウザを閉じて `/quit`。

どちらの方法でも、Codex は `[hooks.state.<key>]` に SHA-256 ハッシュを書き込みます。再付与が必要になるのは hook の command や matcher を **編集したとき** だけ（ハッシュが変わって untrusted に戻る）。

機能フラグは `[features] hooks = true`。Codex < 0.131 では deprecated alias の `codex_hooks = true` も受け付けますが起動時に警告が出ます。

ソース：`codex-rs/hooks/src/engine/discovery.rs`（`HookTrustStatus` フィルタ）、`codex-rs/tui/src/bottom_pane/hooks_browser_view.rs`（`t` キーマップ）、`codex-rs/features/src/legacy.rs`（alias 定義）。<https://github.com/openai/codex>

### 共通の前提

- face-app と MCP server が起動していること（operator stack が両方を立ち上げます）。動いていない場合、wrapper は stderr に1行残して exit 0 で抜けるので agent runtime 側は止まりません。
- `MH_FACE_AGENT_ID` が agent process の環境変数として設定されていること。`scripts/run-bound-mcp-server.sh` が helper 用に、`scripts/run-operator-once.sh` が operator 用に設定済みです。
- 設定例の `/abs/path/to/scripts/mh-hook.mjs` は各自の clone の絶対パスに置換してください。
- 発話テンプレートは `~/.minimum-headroom/face-templates.json` に置けます。無ければ組込みデフォルト（日本語＋英語）が使われます。

### 出力規律（重要）

`mh-hook.mjs` は **どんな状況でも stdout に何も出さず exit 0** に固定されています。理由：

- Gemini CLI は hook の stdout を JSON としてパースする → 余計な出力で破綻
- Gemini の `AfterAgent` は exit code `2` を「stderr を新しい prompt として retry」と解釈 → safety net hook が exit 2 すると無限 retry ループに陥る
- Codex hook も exit `2` を block として扱う

wrapper を改造する場合もこの不変条件は維持してください。

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

face-app は同じ `(agent_id, event)` ペアで直前と異なるバリアントを優先選択します。言語は agent の直近 `face_say` 履歴から自動判定（CJK 文字を含む → `ja`、それ以外 → `en`）、まだ発話歴が無いときは `MH_FACE_LANG` 環境変数がフォールバック。

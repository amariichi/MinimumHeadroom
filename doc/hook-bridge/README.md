# Hook bridge configuration

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

### Choose the existing setup path

MCP exposes MH tools to an agent. Hooks report lifecycle/input state even when the agent does not call those tools. Configure and verify both; neither a config file nor a successful MCP ping proves that hooks run and reach the inbox.

- **Bundled voice-first launcher:** [RMH setup](../../examples/rmh-voice-mode/README.md). It supplies per-launch MCP and hook settings for Claude/Codex, and installs/synchronizes the agy plugin. It requires an existing MH stack and does not replace normal CLI authentication. Its model defaults are documented there; select a model explicitly when you need to retain another choice.
- **Manual Claude launch:** [Claude setup](../examples/claude-code/README.md), then merge `claude-settings.json.example` into the appropriate settings scope.
- **Manual Codex launch:** merge the required MCP and hook entries from [the Codex template](../examples/codex/config.toml) into one selected config source. Keep existing model/auth/permission settings.
- **agy CLI or GUI:** [Antigravity setup](../examples/antigravity/README.md) explains their different registration locations. Use the CLI plugin `hooks.json` for the tested CLI path; do not assume a GUI or compatibility snippet has identical event coverage.

Replace placeholder paths with your checkout path. Do not overwrite an existing config or install the same hook at several scopes. Installed hooks do not imply permission to run arbitrary commands.

### Events and state

The examples use passive observers:

| Runtime | Observations used by the bridge |
| --- | --- |
| Claude Code | `PreToolUse` for `AskUserQuestion`/`ExitPlanMode`; `PermissionRequest`; `PostToolUse`/`PostToolBatch`; `UserPromptSubmit`; `Stop`/`StopFailure`; selected `Notification` subtypes. |
| Codex CLI | `PermissionRequest`; `PreToolUse` for `request_user_input`; `PostToolUse`; `UserPromptSubmit`; `Stop`; `Interrupt`; `SessionEnd`. |
| agy CLI | `PreToolUse` for `ask_question`/`ask_permission`; `PostToolUse`; `PreInvocation`; `Stop`, with known terminal approval layouts as a fallback. |

Integration checks covered Codex 0.163.0, Claude Code 2.1.306 and agy 1.4.5. Availability and payloads vary by version; a configured hook with no corresponding runtime event cannot supply evidence. The agy current-model role check used Gemini 3.8 Flash (Low); it is not a guarantee for all models or all tool choices.

- A response ending (`Stop`) is **idle awaiting instructions**, not task success. Only an explicit helper `done`/`review_findings` reports completion.
- Questions and approvals are separate waits. Native request/session/turn identities, or uniquely matching complete tool/action fingerprints, correlate them. Matching a tool name or nearby timestamp alone is insufficient.
- A matching result, interruption, or a supported ready terminal frame can resolve an observed wait. Unrelated concurrent waits and helper-declared questions remain pending.
- Claude's delayed `Notification:permission_prompt` has no reliable request identity and is ignored; primary events and concrete terminal observations own the wait.
- A terminal snapshot is a fallback for known layouts. Missing, changed or ambiguous output is not proof that someone answered. Open the matching pane if the inbox lacks the actual choice text; the bridge does not invent choices or press approval keys.

See [helper reporting and owner inbox](../guides/multi-agent.md#helper-reporting-and-owner-inbox) for the operator/helper workflow.

When speech is enabled, automatic waiting notices name the safe provider/helper identity and distinguish approval, answer and choice waits. Unknown state asks for a status check rather than claiming failure or completion. Assigned helpers speak through the owner notification once; resolved waits are removed from pending synthesis/playback without clearing other waits. These notices do not read question bodies, command arguments or private paths aloud. Updating this speech behavior requires an MH app reload and browser-page refresh; hook registration alone does not activate it.

### Codex: review the exact definitions

1. Start Codex through the **same launch path and checkout** you intend to use. A bare `codex` cannot review session-only definitions supplied by another launcher.
2. Open `/hooks`. If the command remains buffered, accept the slash command and submit it. Inspect each intended MH handler's source, command and matcher. Do not trust unrelated handlers simply because they are listed.
3. Use the official review controls for the intended definitions. Codex 0.163.0 shows `Installed`, `Active` and a `Review` count when needed. Verify the MH handlers become active; a saved trust entry alone is not a delivery check.
4. Trust hashes persist under `[hooks.state]` in normal `~/.codex/config.toml`. An identical definition/source can reuse trust; command, matcher, timeout or source/path changes can require review again. Recheck after upgrades rather than blindly trusting everything.

Command hooks run outside the Codex sandbox. These observers emit no approval decision; keep your command sandbox and approval policy unchanged. The repository's older `grant-codex-hook-trust.sh` automates an older hook-browser layout and should not be used as a substitute for reviewing current definitions or as proof that all current events are active.

Official behavior: [Codex hooks](https://developers.openai.com/codex/hooks).

### Updating an existing installation

User, project, session and plugin hook sources are additive. Adding new per-launch hooks does **not** replace old global registrations. Before migration, compare the actual command paths in `/hooks`, including any old `permission_required`/`idle_after_response` announcers and legacy `notify` configuration. Select one intended notification path to avoid duplicates.

Review old entries individually. Removing or persistently disabling a user-level hook can affect other Codex launches sharing that configuration. Do not change unrelated hooks, credentials or command approval settings. Do not use a trust-bypass flag to hide a registration problem. A process-only override must be checked in the active hook list and against startup warnings: Codex 0.163.0 ignored a dotted `-c hooks.state.<quoted-source-path>.enabled` override, so that spelling is not a verified migration recipe. Stop if the intended old entries remain active.

After moving or releasing the checkout, update registration paths and repeat review only for changed definitions. Confirm the MCP connection, active hooks and actual delivery separately. A release tag does not automatically repair local registrations.

### Verify and troubleshoot

1. Start the MH app and the configured CLI. Ensure the CLI can call `face_ping` through the expected MH server.
2. For Codex, inspect the active MH handlers in `/hooks`; for the other CLIs, check their installed plugin/settings source and startup diagnostics.
3. Use a harmless helper task that reports a question, waits for your answer, then explicitly reports `done`. Check the correct owner inbox, one notification for each distinct wait, and resolution of only the answered question.
4. If a real permission prompt appears, answer it normally. Check that its matching wait resolves and unrelated questions stay visible. Refusal/interruption is not successful task completion.

Hooks need `MH_FACE_AGENT_ID` and the correct `FACE_WS_URL` in the CLI process environment. A secured MH endpoint also needs the existing `MH_FACE_AUTH_TOKEN` available to the hook process. The MCP wrapper can obtain a token from the normal environment/env file; that alone does not prove the separate hook process inherited it. Do not put real tokens into checked-in examples. Without a configured identity the bridge does nothing; send failures are reported on stderr while the CLI continues.

The observer exits zero and uses silent stdout for Claude/Codex. agy input observers use `--stdout-mode silent`; retain the documented host-specific output mode for other agy hook examples. `MH_HOOK_SUPPRESS_EVENTS` drops listed canonical events **before delivery**, so it can suppress state updates as well as speech. Inspect it when events are missing; do not mistake suppression for successful execution.

Notification wording can be customized in `~/.minimum-headroom/face-templates.json`; built-in Japanese/English defaults are used otherwise. CLI output, inbox details and diagnostic captures may contain private data. Keep runtime records and live captures out of commits; public regression fixtures use synthetic identities and paths.

<a id="japanese"></a>
## 日本語

### 既存の設定経路を選ぶ

MCP はエージェントへ MH のツールを提供し、hook はツールを呼ばない場合もライフサイクル・入力待ちを通知します。両方を設定・確認してください。設定ファイルがあることや MCP ping の成功だけでは、hook の実行と受信箱への配送までは確認できません。

- **同梱の音声優先ランチャ:** [RMH の設定](../../examples/rmh-voice-mode/README.md)。Claude/Codex へ起動単位の MCP・hook 設定を渡し、agy ではプラグインをインストール・同期します。既存の MH スタックが必要で、CLI の通常の認証は置き換えません。モデルの既定値は同ページを参照し、別の選択を維持したい場合は明示してください。
- **Claude の手動起動:** [Claude 設定](../examples/claude-code/README.md)に従い、`claude-settings.json.example` を必要な設定スコープへマージします。
- **Codex の手動起動:** [Codex 設定例](../examples/codex/config.toml)から必要な MCP・hook 項目を選んだ1か所へマージします。モデル・認証・権限設定は残してください。
- **agy CLI または GUI:** 読み込み先の違いは [Antigravity 設定](../examples/antigravity/README.md)を参照してください。検証した CLI 経路はプラグインの `hooks.json` です。GUI や互換スニペットのイベント対応が同じとは限りません。

仮のパスを手元のチェックアウトへ置き換えてください。既存設定全体の上書きや、同じ hook の複数スコープへの登録は避けます。hook の登録は任意コマンドの実行許可ではありません。

### イベントと状態

設定例は、承認判断を変更しない観測用 hook です。

| 実行環境 | ブリッジが利用する観測 |
| --- | --- |
| Claude Code | `AskUserQuestion`/`ExitPlanMode` の `PreToolUse`、`PermissionRequest`、`PostToolUse`/`PostToolBatch`、`UserPromptSubmit`、`Stop`/`StopFailure`、一部の `Notification`。 |
| Codex CLI | `PermissionRequest`、`request_user_input` の `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`Interrupt`、`SessionEnd`。 |
| agy CLI | `ask_question`/`ask_permission` の `PreToolUse`、`PostToolUse`、`PreInvocation`、`Stop`。既知の端末承認画面を補助経路として利用。 |

連携確認には Codex 0.163.0、Claude Code 2.1.306、agy 1.4.5 を使いました。イベントの有無と内容はバージョンで変わります。設定した hook に対応するイベントを CLI が出さなければ根拠にはできません。agy の現在モデルでの役割確認は Gemini 3.8 Flash (Low) での小さな試験で、全モデル・全ツール選択の保証ではありません。

- 応答終了（`Stop`）は **指示待ち** であり、作業成功ではありません。完了はヘルパーの明示的な `done`/`review_findings` で報告します。
- 質問と承認は別の待ちです。要求・セッション・ターンの識別子、または完全なツール入力・操作の一意な fingerprint で対応づけます。ツール名や時刻の近さだけでは統合しません。
- 対応する結果・中断・対応済みと分かる既知の端末表示で、観測由来の待ちを解除します。独立した同時待ちや、ヘルパー自身が報告した質問は残します。
- Claude の遅延 `Notification:permission_prompt` は要求を識別できないため無視します。一次イベントと具体的な端末観測が待ちを管理します。
- 端末取得は既知レイアウト用の補助です。取得失敗・表示変更・曖昧な出力を回答の根拠にはしません。受信箱に選択肢の本文がなければ対象ペインで確認します。ブリッジは選択肢を推測せず、承認キーも自動で押しません。

委任の流れは [ヘルパーレポートとオーナー受信箱](../guides/multi-agent.md#ヘルパーレポートとオーナー受信箱)を参照してください。

音声が有効な場合、自動の待ち通知は安全なプロバイダー／ヘルパー名で、承認・回答・選択の待ちを区別します。理由不明なら失敗や完了を断定せず、状態確認を促します。割当済みヘルパーはオーナー通知から一度だけ発話し、解消済みの待ちは他の待ちを消さずに合成・再生待ちから除きます。質問本文、コマンド引数、私的なパスは自動で読み上げません。この音声処理の更新には MH アプリの再読み込みとブラウザ画面の更新が必要で、hook の登録だけでは有効になりません。

### Codex: 実際の定義を確認して信頼する

1. **普段使うのと同じ起動方法・チェックアウト** で Codex を起動します。別のランチャだけが渡す起動単位の定義は、単独の `codex` では確認できません。
2. `/hooks` を開きます。入力が残っていたらスラッシュコマンドを確定・送信してください。対象 MH handler の読み込み元・コマンド・matcher を確認します。一覧にある無関係な handler まで信頼しないでください。
3. 公式画面で対象定義を承認します。Codex 0.163.0 では `Installed`、`Active`、必要なら `Review` 件数が表示されます。対象が有効になったことを確認します。信頼情報の保存だけでは配送確認にはなりません。
4. 信頼 hash は通常の `~/.codex/config.toml` の `[hooks.state]` へ保存されます。同じ定義・読み込み元なら再利用できます。command・matcher・timeout・読み込み元やパスが変われば再確認が必要になることがあります。更新後も一括で盲目的に信頼しないでください。

コマンド hook は Codex のサンドボックス外で動きます。この観測用 hook は承認判断を返しません。コマンドの sandbox・承認方針は維持してください。旧 `grant-codex-hook-trust.sh` は古い hook 画面向けの自動操作で、現行定義の確認や全イベントが有効であることの証明には代用できません。

公式の挙動は [Codex hooks](https://developers.openai.com/codex/hooks)を参照してください。

### 既存インストールの更新

ユーザー・プロジェクト・起動単位・プラグインの hook は加算されます。起動単位の新定義は、旧グローバル定義を置き換えません。移行前に `/hooks` で実際のコマンドを比較し、古い `permission_required`/`idle_after_response` の通知や legacy `notify` の設定も確認します。重複を避けるため、意図した通知経路を選んでください。

旧項目は1件ずつ確認します。ユーザー単位の hook の削除・永続的な無効化は、その設定を共有する別の Codex 起動にも影響します。無関係な hook、認証情報、コマンド承認設定は変えません。信頼回避フラグで登録の問題を隠さないでください。プロセス限定 override は、有効な hook 一覧と起動警告で確認が必要です。Codex 0.163.0 では dotted な `-c hooks.state.<引用した読み込み元パス>.enabled` が無視されたため、この書き方を確認済みの移行手順にはできません。旧項目が有効のままなら停止してください。

チェックアウトの移動・リリース後は登録パスを更新し、変更された定義だけを再確認します。MCP 接続、hook の有効状態、実際の配送は別々に確認してください。リリースの tag を付けても手元の登録は自動修復されません。

### 動作確認と切り分け

1. MH アプリと設定済み CLI を起動し、想定した MH サーバー経由で `face_ping` が成功することを確かめます。
2. Codex は `/hooks` の対象 MH handler を確認します。他の CLI はインストールしたプラグイン・設定の読み込み元と起動時の診断を確認します。
3. 無害なヘルパーに質問を報告させ、回答を待たせ、明示的な `done` を返させます。正しいオーナー受信箱、独立した待ちごとに1通知、回答した質問だけの解除を確認します。
4. 実際の承認画面が出た場合は通常どおり回答します。対応する待ちだけが解除され、別の質問が残ることを確認します。拒否・中断を作業成功として扱いません。

hook の実行環境には `MH_FACE_AGENT_ID` と正しい `FACE_WS_URL` が必要です。認証付き MH では、既存の `MH_FACE_AUTH_TOKEN` が hook プロセスにも必要です。MCP ラッパーが通常の環境・env ファイルから token を取得できても、別の hook プロセスへ継承されたとは限りません。実 token はチェックインする設定例に書かないでください。識別子がなければ何もせず、配送失敗時は標準エラーへ記録して CLI を続行します。

観測 hook は終了コード0、Claude/Codex では無音の標準出力を使います。agy の入力観測は `--stdout-mode silent` を使い、ほかの agy 例はホストに合う出力規則を維持します。`MH_HOOK_SUPPRESS_EVENTS` は対象イベントを **配送前に除外** するため、音声だけでなく状態更新も抑えます。イベントが届かなければ確認し、抑制を動作成功と取り違えないでください。

通知の文言は `~/.minimum-headroom/face-templates.json` で変更でき、未設定なら日本語・英語の既定値を使います。CLI 出力、受信箱の詳細、診断用 capture には個人情報が含まれることがあります。実行時記録や実測 capture はコミットせず、公開する回帰 fixture は架空の識別子・パスを使ってください。

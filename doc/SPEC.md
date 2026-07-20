# Minimum Headroom: 仕様一式（Codex / Claude Code / Antigravity 向け）

本書は、MCP に対応したエージェント（Codex CLI、Claude Code、Antigravity など）から制御できる、
「簡易 3D 頭部で作業状態を表し、Kokoro TTS で読み上げるアプリ」の **MVP 実装仕様**です。
開発担当のエージェントに、そのまま渡せる具体性を目標にしています。

---

## 1. 目的

- CLI 上で動く AI エージェントの進捗、行き詰まり、成功・失敗、許可待ちなどの状態を、
  **独立ウィンドウに表示する簡易 3D 頭部**（福笑いのような多少の崩れを許容）と **短い TTS 発話**で補完する。
- 自然さは不要。むしろ多少のズレ・滑稽さは歓迎。
- 発話では **情報の鮮度を優先**する。生成中または発話中に状態が変わった場合は、古い結果を破棄する。

---

## 2. 対象環境（MVP）

- OS: 主対象は Ubuntu
- 将来の対象: macOS も想定する。ただし、MVP では Ubuntu を優先する
- Face App: Web 技術を使用する（Electron と Three.js を想定）
- TTS: Ubuntu では **Kokoro-82M (ONNX) + Misaki G2P** を使用する
  - voice: 既定値は **jf_alpha**。起動時に `MH_KOKORO_VOICE` で上書きできる
  - 日本語の速度: **1.2 倍**（`speed=1.2`）
  - ASCII（`\x20`〜`\x7E`）は英語、それ以外は日本語として扱う
  - 漢字を実用的な範囲で読ませるため、Misaki を必須とする

参考として、Kokoro-82M (ONNX) では次のモデルファイルを使用します。

- `kokoro-v1.0.onnx` と `voices-v1.0.bin`
- 取得元: `https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/`

---

## 3. 全体アーキテクチャ

### 3.1 コンポーネント

1. **Face App（Electron）**

   - 独立ウィンドウに簡易 3D 頭部を描画する（Three.js）
   - localhost 上の WebSocket サーバーとして JSON を受信する
   - 状態を更新し、表情や動作を生成して描画に反映する
   - Kokoro による TTS の生成・再生と、キャンセルを制御する
   - 再生中は `mouth_open` を動かして簡易的な口パクを行う。音声との厳密な同期は不要

2. **MCP Server（Node.js、stdio transport）**

   - MCP ツールとして `face.event`、`face.say`、任意（ただし推奨、§5.3）の `face.ping` を公開する
   - 受け取った引数を Face App の WebSocket へ送信し、応答を待たずに処理を戻す
   - **stdio 型**とし、Codex、Claude Code、Antigravity のいずれからも利用できるようにする

3. **任意のログ監視アダプター**

   - 特定の CLI ログからイベントを自動生成する仕組みは、後から追加できるようにする
   - MVP では、エージェント自身が MCP ツールを呼び出せればよい
   - エージェントが MCP ツールを呼ばない場合にも備え、アダプターを追加しやすい構成にする

---

## 4. 通信仕様（Face App WebSocket）

### 4.1 エンドポイント
- 既定値: `ws://127.0.0.1:8765/ws`
- MVP では、MCP Server から Face App への一方向通信だけで成立する

### 4.2 メッセージ共通フィールド

```json
{
  "v": 1,
  "type": "event|say|ping",
  "session_id": "string",
  "ts": 1730000000000
}
```

- `session_id`: セッションを識別する必須の値
- `ts`: Unix エポックからの経過ミリ秒。MCP Server 側での付与を推奨する

現行実装では、エージェント個体の識別には `agent_id` を使います。`session_id` は
`agent_id` の代わりにはなりません。`MH_FACE_AGENT_ID` が設定されたプロセスでは MCP Server が
`agent_id` を補います。設定されていない場合は、各フェイスツールの引数へ明示してください。
詳しくは
[`doc/examples/AGENT_RULES.md`](examples/AGENT_RULES.md#stable-agent-id-identity)を参照してください。

---

## 5. MCP ツール仕様（Node.js、stdio transport）

実装で公開する MCP ツール名は `face_event`、`face_say`、`face_ping` です。本書では設計上の
名前として、ドット区切りの `face.event`、`face.say`、`face.ping` を使います。

### 5.1 `face.event`

**目的**: 作業中に起きた出来事を送る。対応する表情や動作は Face App 側で決める。

**引数**:
```json
{
  "session_id": "string",
  "name": "cmd_started|cmd_failed|cmd_succeeded|tests_failed|tests_passed|permission_required|retrying|idle",
  "severity": 0.0,
  "meta": {},
  "ttl_ms": 30000
}
```

- `severity`: 0〜1。未指定時は 0.5
- `meta`: 任意。`exit_code`、`stderr_len`、`cmd`、ツール名などを格納する
- `ttl_ms`: イベントの有効期間。MVP では受信直後に反映してもよい

Face App へ送る JSON の例:
```json
{
  "v": 1,
  "type": "event",
  "session_id": "codex#1",
  "ts": 1730000000000,
  "name": "cmd_failed",
  "severity": 0.7,
  "meta": {"exit_code": 1, "cmd": "pytest"},
  "ttl_ms": 30000
}
```

---

### 5.2 `face.say`

**目的**: 短い発話を提案する。発話の抑制、キャンセル、破棄は Face App 側で管理する。

**引数**:
```json
{
  "session_id": "string",
  "text": "string",
  "priority": 0,
  "policy": "replace|interrupt",
  "ttl_ms": 4000,
  "dedupe_key": "string|null",
  "utterance_id": "string|null",
  "message_id": "string|null",
  "revision": 1730000000000
}
```

- `priority`: 0..3
  - 3: 必須（許可要求、完了、致命的な状態）
  - 2: 失敗、方針転換
  - 1: 相槌（thinking/confused）
  - 0: 雑談
- `policy`:
  - `interrupt`: 再生中の音声も停止して差し替え
  - `replace`: キュー内または生成中の発話を置き換える。再生中の音声は原則として止めないが、Face App 側の判断で停止してもよい
- `ttl_ms`: 期限切れは **生成しても再生しない**
- `dedupe_key`: 同種の繰り返し抑制用（例：permission_required）
- `utterance_id`: 未指定の場合は MCP Server が UUID を発行する
- `message_id`: 送信単位の識別子。未指定の場合は MCP Server が UUID を発行する
- `revision`: 最新表示保証のための単調増加値（未指定なら送信時刻を使用）

Face App へ送る JSON の例:
```json
{
  "v": 1,
  "type": "say",
  "session_id": "codex#1",
  "ts": 1730000000000,
  "utterance_id": "uuid-...",
  "message_id": "msg-...",
  "revision": 1730000000000,
  "text": "許可をお願いします",
  "priority": 3,
  "policy": "interrupt",
  "ttl_ms": 7000,
  "dedupe_key": "permission_required"
}
```

---

### 5.3 `face.ping`（任意だが推奨）

**目的**: Face App への接続を確認する。一度の失敗を理由に、エージェントが以後の呼び出しをやめてしまう状態を防ぐ。

- 引数: `{ "session_id": "string" }`
- 結果: `{ "ok": true, "ws": "..." }` など

---

## 6. Face App 内部の状態設計

### 6.1 状態変数

- `confused`（困惑）
- `frustration`（苛立ち）
- `confidence`（自信）
- `urgency`（切迫）
- `stuckness`（詰まり）
- `fail_streak`（連続失敗回数を表す整数）

### 6.2 更新ルール（MVP推奨）

- `cmd_started`: `urgency += 0.05*severity`
- `cmd_failed`:
  - `fail_streak += 1`
  - `confused += 0.12*severity + min(0.05*fail_streak, 0.2)`
  - `frustration += 0.08*severity`
  - `confidence -= 0.10*severity`
- `cmd_succeeded`:
  - `fail_streak = 0`
  - `confused *= 0.6`
  - `frustration *= 0.7`
  - `confidence += 0.15`
- `tests_failed`: `stuckness += 0.18 + 0.1*severity`
- `tests_passed`: `stuckness *= 0.6`
- `permission_required`:
  - `urgency += 0.35`
  - `confidence -= 0.15`

**時間による減衰（10 Hz で十分）**:
- `confused *= exp(-dt/12s)`
- `frustration *= exp(-dt/20s)`
- `urgency *= exp(-dt/18s)`
- `stuckness *= exp(-dt/25s)`
- `confidence` は 0.5 にゆっくり回帰（例：`confidence += (0.5-confidence)*dt/30s`）

`fail_streak` を除く各値は、0〜1 の範囲に収める。

---

## 7. 3D 顔モデルの要件（プリミティブ生成）

外部アセットを使わず、コーディングエージェントだけで生成できる構成にします。

### 7.1 パーツ

- 頭部: `SphereGeometry` を拡縮した楕円球
- 眉: `Line` または `BoxGeometry` による棒状の形
- 目: 楕円形の白目、円形の黒目、開閉するまぶた
- 鼻: 分割数を少なくした `ConeGeometry` による三角錐
- 口: 開閉する楕円または矩形

### 7.2 制御パラメータ（正規化）

- 頭部: `yaw`、`pitch`、`roll`（-1〜1）
- 眉:
  - `brow_raise_l`、`brow_raise_r`（0〜1）
  - `brow_tilt`（-1〜1）
  - `brow_furrow`（0〜1）
- 目:
  - `eye_open_l`、`eye_open_r`（0〜1）
  - `gaze_x`、`gaze_y`（-1〜1）
  - まばたきは内部で自動生成する
- 口:
  - `mouth_open`（0〜1）
  - `mouth_wide`（0〜1、任意）

### 7.3 範囲・速度制限

- `yaw` は ±20 度、`pitch` は ±15 度、`roll` は ±18 度程度に制限する
- 各パラメータは、`lerp` などによる一次遅れで滑らかに変化させる（`alpha` は 0.05〜0.2）
- 状態値が高いほど、揺らぎ（`jank`）を増やす
  - `jank = clamp(0.15 + 0.5*confused + 0.2*frustration, 0..1)`
  - 左右差やタイミングのずれを `jank` に応じて増減させる

---

## 8. 3D ならではの動作（必須）

Face App の内部にジェスチャー生成器を設け、固定のプリセットではなく確率に基づいて動作を選びます。

### 8.1 うなずき（nod）

- トリガー: `cmd_succeeded`、`tests_passed`
- `pitch` を 2 回程度、減衰振動させる（0.4〜0.9 秒）
- 振幅は `confidence` と `urgency` に応じて調整する

### 8.2 首かしげ（tilt）

- トリガー: `cmd_failed` が続いた場合、または `permission_required`
- `roll` をゆっくり一定の角度まで動かし、元に戻す（1〜2 秒）
- `confused` が高いほど、角度を大きくして保持時間を延ばす

### 8.3 首振り（shake）

- トリガー: 連続した失敗、否定
- `yaw` を左右に振動させる（0.6〜1.2 秒）
- `frustration` が高いほど、速く大きく動かす

MVP では、`event -> state -> 確率に基づく gesture の選択` という流れにします。
将来、低レベルの `face.gesture` ツールを追加するかどうかは任意です。

---

## 9. TTS の要件（Ubuntu: Kokoro + Misaki）

### 9.1 言語分割
- ASCII（`\x20`〜`\x7E`）が連続する部分は英語として扱う（`lang='en-us'`）
- それ以外は日本語として扱う（`lang='j'`）
- voice の既定値は `jf_alpha`。起動時に `MH_KOKORO_VOICE=af_heart` などで上書きできる

### 9.2 日本語 G2P

- Misaki の `ja.JAG2P()` を必須とする
- 日本語のまとまりを音素に変換し、`is_phonemes=true` を指定して Kokoro へ渡す
- 速度:
  - 日本語: 1.2
  - 英語: 1.0

### 9.3 最重要: キャンセルと破棄

古い発話が滞留しないよう、次の規則を守ります。

- `utterance_id` を発話の世代管理に使用する
- 新しい `say` を受信したら `current_utterance_id` を更新する
- 生成中、再生前、再生中のどの段階でも、次の条件で発話を破棄する
  - `utterance_id != current_utterance_id` になったら **破棄**
- `ttl_ms` を過ぎた発話は、生成が完了していても再生しない

### 9.4 再生停止（interrupt）
- `policy=interrupt` または `priority=3` の発話を受信した場合は、**再生中の音声も停止**する
  - sounddevice: `sd.stop()`
  - aplay: `Popen` を保持して `terminate()` を呼び、停止しない場合は `kill()` を呼ぶ

---

## 10. 簡易的な口パク

- 再生中だけ `mouth_open` を動かす
- 最小構成では、正弦波とノイズを組み合わせる
- 余裕があれば、音声の RMS に追従させる
- キャンセルによって再生を停止した場合は、直ちに `mouth_open` を 0 に戻す

---

## 11. 発話頻度の制御（Face App 側のゲート）

「1 ターンにつき 1 回」のような固定規則は使わず、Face App 側で頻度を制限します。

### 11.1 推奨

- `priority=3`: 原則として通す。`interrupt` を優先し、重複排除はしない
- `priority=2`: `dedupe_key` がある場合だけ、短時間の重複を除外する（例: 3 秒）
- `priority=1`: 最小間隔を 8 秒とする（設定で変更可能）
- 全体: `priority<=2` の発話を、60 秒あたり最大 3 回に制限する
- セッション単位: `priority<=2` の発話を、60 秒あたり最大 1 回に制限する

### 11.2 重複排除

- `dedupe_key` が明示された場合のみ抑制する
- `dedupe_key=null` の場合は重複排除を行わない
- `priority=3` には重複排除を適用しない

---

## 12. 人が読みやすい設定ファイル

Face App が読み込む `config.yaml` の例:

```yaml
TTS:
  エンジン: kokoro
  ボイス: jf_alpha
  起動時上書き: MH_KOKORO_VOICE
  日本語速度倍率: 1.2
  英語速度倍率: 1.0
  半角ASCIIは英語: true
  Misaki必須: true
  TTL_ms: 4000
発話制御:
  priority1_最小間隔_ms: 8000
  global_60s_上限: 3
  session_60s_上限: 1
  dedupe_ms: 30000
WebSocket:
  host: 127.0.0.1
  port: 8765
表示:
  active_session_policy: last_active
```

内部では、英語のキーに正規化して扱っても構いません。

---

## 13. 受け入れ基準（MVP）

### 13.1 3D/状態

- `cmd_failed` を連続して送ると、`confused` に対応する挙動（眉の傾き、首かしげ、首振りなど）が増える
- `cmd_succeeded` で落ち着く（即ゼロではなく減衰）

### 13.2 TTS（鮮度）

- 生成中に新しい `interrupt` を受信した場合、古い発話を再生しない
- 再生中に `interrupt` を受信した場合、音声を停止する
- `ttl_ms` を超過した発話を再生しない

### 13.3 うるささ

- `priority=1` を連続して送っても、最小間隔に従って抑制される
- 許可を求める同一文言は、重複排除によって抑制される

### 13.4 複数セッション

- `session_id` が異なる入力を交互に送っても破綻しない
- MVP では、`last_active` のセッションを前面に表示する

---

## 14. リポジトリ同梱物（推奨）

- `doc/examples/AGENT_RULES.md`（スキルを使わずに導入できる、呼び出しルールの説明）
- `doc/examples/` に置く各クライアント向けの設定例
  - codex: `config.toml`
  - claude code: `claude mcp add ...` コマンド例 + JSON例
  - antigravity: `mcp_config.json`

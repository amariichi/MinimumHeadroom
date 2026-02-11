# Minimum Headroom: 仕様一式（Codex/Claude Code/Antigravity向け）

本書は、MCP対応エージェント（Codex CLI / Claude Code / Antigravity 等）から制御できる
「作業状態を表出する簡易3D頭部 + Kokoro TTS」アプリの **MVP実装仕様**です。
開発担当（Codex等）にそのまま渡せる粒度を目標にしています。

---

## 1. 目的

- CLIで動くAI agentの進捗・躓き・成功/失敗・許可待ちなどの状態を、  
  **独立ウィンドウの簡易3D頭部**（福笑いっぽい崩れを許容）と **短いTTS発話**で補完する。
- 自然さは不要。むしろ多少のズレ・滑稽さは歓迎。
- 重要：発話は **鮮度優先**。生成中/発話中に状態が変わったら、古い結果は捨てる。

---

## 2. 対象環境（MVP）

- OS: Ubuntu（メイン）
- 将来: macOSも想定（ただしMVPはUbuntu優先）
- Face App: Web技術（Electron想定、Three.js）
- TTS: Ubuntuは **Kokoro-82M (ONNX) + Misaki G2P** を使用
  - voice: **af_heart 固定**
  - 日本語速度: **1.2倍**（speed=1.2）
  - ASCII(\x20-\x7E)は英語扱い、それ以外は日本語扱い
  - Misakiは必須（漢字を許容範囲で読むため）

（参考）Kokoro-82M (ONNX) のモデルファイル：
  - `kokoro-v1.0.onnx` と `voices-v1.0.bin`
  - 取得元（参考情報）：`https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/`

---

## 3. 全体アーキテクチャ

### 3.1 コンポーネント

1) Face App（Electron）
- 独立ウィンドウで簡易3D頭部を描画（Three.js）
- localhost WebSocketサーバとしてJSONを受信
- state更新 → 表情/動作生成 → 描画へ反映
- TTS生成・再生（Kokoro）とキャンセル制御
- 口パク（簡易）: 再生中に mouth_open を動かす（厳密同期不要）

2) MCP Server（Node, stdio transport）
- MCPツールとして `face.event` / `face.say` /（任意）`face.ping` を公開
- 受けた引数を Face App の WebSocket に転送（fire-and-forget）
- **stdio型**にしてクライアント汎用（Codex/Claude Code/Antigravity）

3) 任意: アダプタ（ログ監視）
- Codex/Claude/Gemini等、特定CLIログから event を自動生成するのは後付け可能
- MVPでは agent 自身が MCPツールを呼べればOK
- ただし「呼ばない日」の保険として後で導入しやすい設計にする

---

## 4. 通信仕様（Face App WebSocket）

### 4.1 エンドポイント
- `ws://127.0.0.1:8765/ws`（既定）
- MCP Server → Face App 方向のみでMVP成立

### 4.2 メッセージ共通フィールド

```json
{
  "v": 1,
  "type": "event|say|ping",
  "session_id": "string",
  "ts": 1730000000000
}
```

- `session_id`: エージェント識別子（必須）。複数エージェント同時運用のため。
- `ts`: epoch ms（MCP側で付与推奨）

---

## 5. MCPツール仕様（Node stdio MCP Server）

### 5.1 `face.event`

**目的**: 世界の出来事を送る（表情・動作はFace側で決める）。

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

- `severity`: 0..1（未指定は0.5）
- `meta`: 任意（exit_code, stderr_len, cmd, tool名など）
- `ttl_ms`: 古いイベントは捨てても良い（MVPは受信後即反映でもOK）

Face Appへ送るJSON（例）:
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

**目的**: 短い発話を提案する（Face側が抑制/キャンセル/破棄を管理）。

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
  - 3: 必須（許可要求/完了/致命）
  - 2: 失敗/方針転換
  - 1: 相槌（thinking/confused）
  - 0: 雑談
- `policy`:
  - `interrupt`: 再生中の音声も停止して差し替え
  - `replace`: キュー/生成中は置換（再生中は基本止めないが、Face側裁量で止めても良い）
- `ttl_ms`: 期限切れは **生成しても再生しない**
- `dedupe_key`: 同種の繰り返し抑制用（例：permission_required）
- `utterance_id`: 未指定ならMCPサーバがUUID発行
- `message_id`: 送信単位の識別子（未指定ならMCPサーバがUUID発行）
- `revision`: 最新表示保証のための単調増加値（未指定なら送信時刻を使用）

Face Appへ送るJSON（例）:
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

**目的**: Face App接続確認。エージェントが「失敗→以後呼ばない」状態になるのを防ぐ。

- 引数: `{ "session_id": "string" }`
- 結果: `{ "ok": true, "ws": "..." }` など

---

## 6. Face App 内部：状態（state）設計

### 6.1 state変数（0..1）

- `confused`（困惑）
- `frustration`（苛立ち）
- `confidence`（自信）
- `urgency`（切迫）
- `stuckness`（詰まり）
- `fail_streak`（連続失敗回数, int）

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

**時間減衰（10Hzで十分）**:
- `confused *= exp(-dt/12s)`
- `frustration *= exp(-dt/20s)`
- `urgency *= exp(-dt/18s)`
- `stuckness *= exp(-dt/25s)`
- `confidence` は 0.5 にゆっくり回帰（例：`confidence += (0.5-confidence)*dt/30s`）

各値は 0..1 にclamp。

---

## 7. 3D顔モデル要件（プリミティブ生成）

外部アセットなしで生成する（coding agentで作成可能）。

### 7.1 パーツ
- 頭部: SphereGeometryをscaleして楕円球
- 眉: Line / BoxGeometry（棒）
- 目: 白目（楕円）+ 黒目（円）+ まぶた（開閉）
- 鼻: 三角錐（ConeGeometryで分割少なめ）
- 口: 楕円 or 矩形（開閉）

### 7.2 制御パラメータ（正規化）
- Head: `yaw`, `pitch`, `roll`（-1..1）
- Brow:
  - `brow_raise_l`, `brow_raise_r`（0..1）
  - `brow_tilt`（-1..1）
  - `brow_furrow`（0..1）
- Eye:
  - `eye_open_l`, `eye_open_r`（0..1）
  - `gaze_x`, `gaze_y`（-1..1）
  - blink（内部自動）
- Mouth:
  - `mouth_open`（0..1）
  - `mouth_wide`（0..1, 任意）

### 7.3 範囲・速度制限
- yaw ±20°, pitch ±15°, roll ±18° 程度
- 各パラメータは `lerp` 等の1次遅れで滑らかに（alpha 0.05〜0.2）
- stateが高いほど揺らぎ（jank）を増やす：
  - `jank = clamp(0.15 + 0.5*confused + 0.2*frustration, 0..1)`
  - 左右差やタイミングズレは jank で増減

---

## 8. 3Dならではの動作（必須）

Face App内部に「ジェスチャー生成器」を持つ（プリセット固定ではなく確率で選ぶ）。

### 8.1 うなずき（nod）
- トリガ: `cmd_succeeded`, `tests_passed`
- pitchで2回程度の減衰振動（0.4〜0.9秒）
- amplitudeは `confidence` と `urgency` で調整

### 8.2 首かしげ（tilt）
- トリガ: `cmd_failed` が続く、`permission_required`
- rollをゆっくり一定角→戻す（1〜2秒）
- confusedが高いほど角度/保持が増

### 8.3 首振り（shake）
- トリガ: 連続失敗、否定
- yaw左右振動（0.6〜1.2秒）
- frustrationが高いほど速く/大きく

※MVPでは `event -> state -> (確率で gesture を選択)` とする。
（将来、低レベルに `face.gesture` ツールを足すのは任意。）

---

## 9. TTS要件（Ubuntu固定：Kokoro + Misaki、af_heart、速度）

### 9.1 言語分割
- ASCII (\x20-\x7E) 連続部分 → 英語扱い（`lang='en-us'`）
- それ以外 → 日本語扱い（`lang='j'`）
- voice は常に `af_heart`

### 9.2 日本語G2P
- Misaki `ja.JAG2P()` を必須
- 日本語チャンクは phoneme 化して `is_phonemes=true` でKokoroへ渡す
- speed:
  - 日本語: 1.2
  - 英語: 1.0

### 9.3 最重要：キャンセルと破棄（渋滞禁止）
- `utterance_id` を世代管理として扱う
- 新しい say が来たら `current_utterance_id` を更新
- 生成中/再生前/再生中のいずれでも：
  - `utterance_id != current_utterance_id` になったら **破棄**
- `ttl_ms` を過ぎたら再生しない（生成完了しても捨てる）

### 9.4 再生停止（interrupt）
- `policy=interrupt` または `priority=3` は **再生中も停止**すること
  - sounddevice: `sd.stop()`
  - aplay: Popenを保持し `terminate()`、止まらなければ `kill()`

---

## 10. 口パク（簡易）
- 再生中だけ mouth_open を動かす
- 方式:
  - 最小: sin波 + noise
  - 余裕: 音声RMSで追従
- キャンセル停止したら即 mouth_open -> 0

---

## 11. 発話のうるささ制御（Face側ゲート）
固定「1ターン1回」ではなく、Face側でレート制限。

### 11.1 推奨
- priority=3: 原則通す（interrupt優先、dedupeしない）
- priority=2: dedupe_key がある場合のみ短時間dedupe（例: 3秒）
- priority=1: 最小間隔 8秒（設定可能）
- グローバル: 60秒あたり最大3回（priority<=2対象）
- session: 60秒あたり最大1回（priority<=2対象）

### 11.2 dedupe
- `dedupe_key` が明示された場合のみ抑制する
- `dedupe_key=null` のときは dedupe しない
- `priority=3` には dedupe を適用しない

---

## 12. 設定ファイル（人間が読める“感じ”）

`config.yaml` 例（Face Appが読む）:

```yaml
TTS:
  エンジン: kokoro
  ボイス: af_heart
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

内部では英語キーに正規化して扱ってOK。

---

## 13. 受け入れ基準（MVP）

### 13.1 3D/状態
- `cmd_failed` を連続で送ると confused相当の挙動が増える（眉傾き、首かしげ、首振り等）
- `cmd_succeeded` で落ち着く（即ゼロではなく減衰）

### 13.2 TTS（鮮度）
- 生成中に新しい `interrupt` が来たら古い発話は鳴らない
- 再生中に `interrupt` が来たら音声が止まる
- `ttl_ms` 超過は鳴らない

### 13.3 うるささ
- priority=1連打でも最小間隔で抑制
- permission文言はdedupeで抑制

### 13.4 複数session
- session_idが異なる入力を交互に送っても破綻しない
- 表示は last_active を前面（MVP）

---

## 14. リポジトリ同梱物（推奨）
- `examples/AGENT_RULES.md`（呼び出しルール。skill不要の導線）
- `examples/` に各クライアント設定雛形
  - codex: `config.toml`
  - claude code: `claude mcp add ...` コマンド例 + JSON例
  - antigravity: `mcp_config.json`

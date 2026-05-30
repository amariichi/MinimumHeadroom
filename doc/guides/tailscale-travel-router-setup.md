# Tailscale 非対応デバイスを Tailscale 対応トラベルルーター経由で繋ぐ手順

AtomS3R (ESP32) のように Tailscale クライアントが入らない小型デバイスを、Tailscale 対応のトラベルルーター (GL.iNet GL-MT3600BE 等) を経由して、別ネットワークにいる Tailscale 入りの PC から到達できるようにする手順をまとめます。

「Tailscale subnet routing (サブネットルーター機能)」を使う構成です。

---

## 想定構成

```
[ 自宅LAN  192.168.1.0/24 ]                     [ トラベルルーターLAN  192.168.8.0/24 ]
                                                                  │
   PC (Tailscale入り) ───── Tailscale ─────── トラベルルーター (Tailscale入り)
                                                                  │
                                                          非Tailscaleデバイス
                                                            (例: AtomS3R)
                                                              192.168.8.100
```

ゴール: PC から `http://192.168.8.100/` のような LAN IP に、自宅 LAN にいながら Tailscale 経由で到達できるようにする。

---

## 前提

- トラベルルーターが Tailscale クライアントを内蔵していること (GL.iNet 4.x ファームウェアの GL-MT3600BE, GL-MT2500 など)。
- Tailscale アカウントを持っていて、PC とトラベルルーターを同じ Tailnet に参加させられること。
- 接続したいデバイスが、トラベルルーターの LAN 側に有線/Wi-Fi で繋がっていること。
- トラベルルーターと PC が異なる物理 LAN にいる前提 (同じ LAN にいるなら subnet routing は不要)。

---

## 全体の流れ

1. トラベルルーターを Tailscale に参加させる
2. トラベルルーターで「LAN リモートアクセス」を有効化 (= LAN サブネットを advertise)
3. Tailscale admin console で advertise されたサブネットを Approve
4. ACL に「PC → 対象デバイス」を許可するルールを追加
5. PC 側で `--accept-routes` を有効にして netmap を取り直す
6. 対象デバイスの IP を固定し、アプリケーションから疎通確認

各ステップで詰まりやすいポイントを後述します。

---

## ステップ1: トラベルルーターを Tailscale に参加させる

1. トラベルルーターの管理画面 (`http://192.168.8.1/` 等) に入る。
2. **アプリケーション → Tailscale** を開く。
3. 「**有効化**」を ON にする。
4. 「**アカウントをバインドする**」を押す。表示された認証 URL をブラウザで開き、Tailscale アカウントで認可する。
5. 認可後、画面に **ルーターの仮想 IP** (`100.x.x.x` の Tailnet アドレス) が表示されればOK。
6. `admin.tailscale.com → Machines` にトラベルルーターが現れていることを確認する。

### ハマりポイント

- **古いノードが残ることがある**: 再バインドや初期化を繰り返すと、Machines に同じホスト名の古いノードが残る。古いノードは admin console で削除する。古いノードが残っていると、後段で混乱の元になる。
- **キー期限**: デフォルトで 180 日後に key expiry がある。長期運用するなら admin console で当該ノードを「Disable key expiry」しておくと、外出先で突然繋がらなくなる事故を防げる。

---

## ステップ2: LAN サブネットを advertise する

1. トラベルルーター管理画面 → Tailscale 画面で「**LAN のリモートアクセスを許可する**」トグルを ON。
2. 「**適用**」または「Apply」ボタンを押す。
3. これで内部的に `tailscale up --advertise-routes=<LANサブネット>` が走り、トラベルルーターの LAN サブネット (例 `192.168.8.0/24`) が Tailscale に advertise される。

### 確認方法 (任意)

SSH でトラベルルーターに入れる場合 (GL.iNet なら `ssh root@192.168.8.1`):

```bash
tailscale debug prefs | grep -A2 AdvertiseRoutes
```

`AdvertiseRoutes` が `null` や `[]` ではなく `["192.168.8.0/24"]` のようになっていれば advertise されています。

### ハマりポイント

- **トグル ON だけでは不完全**: advertise しただけでは subnet route は使えません。admin console での Approve (ステップ3) が必須。
- **トグル ON 後の再起動/再バインドでリセットされることがある**: Tailscale 自体を再起動したり、アカウントを再バインドした場合、トラベルルーターのファームウェア仕様によっては LAN advertise 設定が外れることがある。再バインド後は必ずこのトグルを確認する。
- **WAN リモートアクセスは別物**: 「WAN リモートアクセスを許可」は WAN 側 IP に Tailnet からアクセスさせる別機能。LAN 越しに繋ぎたいだけなら OFF のままで OK。
- **Exit Node も別物**: Exit Node を ON にすると Tailnet 全ノードのインターネット出口にできる機能。LAN デバイス到達には無関係なので OFF のまま。

---

## ステップ3: admin console でサブネットを Approve

1. `admin.tailscale.com → Machines` で対象のトラベルルーターを開く。
2. **Subnets** セクション (または右側「…」メニュー → **Edit route settings**) を開く。
3. 「**Awaiting Approval**」欄に `192.168.8.0/24` (など advertise されたサブネット) が表示されているはず。チェックボックスを ON にして保存。
4. 保存後、「**Approved**」欄に移動すれば成功。

### ハマりポイント

- **Awaiting Approval が空の場合**: トラベルルーター側でまだ advertise が走っていない。ステップ2 をやり直す (トグル OFF → 適用 → ON → 適用、または Tailscale 自体を再起動)。
- **Approved に表示されているのに後述のクライアント netmap に来ない場合**: 「過去に approve したが現在は advertise していない」状態のことがある。トラベルルーター側で `AdvertiseRoutes` が空になっていないかステップ2の確認方法で見る。
- **ACL の自動承認との衝突**: ACL に `autoApprovers` を書いている場合、その内容と矛盾していると Awaiting Approval にすら出ない。シンプルな構成では `autoApprovers` を使わない方が分かりやすい。

---

## ステップ4: ACL で PC → 対象デバイスを許可する

`admin.tailscale.com → Access controls` を開き、JSON editor で grant を追加します。

例として、`group:me` に属するユーザーが `192.168.8.100` (AtomS3R など) の TCP 80 番ポートにアクセスできるルール:

```jsonc
{
    "hosts": {
        "atoms3r": "192.168.8.100"
    },

    "grants": [
        // 既存のルール...

        {
            "src": ["group:me"],
            "dst": ["host:atoms3r"],
            "ip":  ["tcp:80"]
        }
    ]
}
```

ポイント:

- `hosts` で LAN IP に名前を付けておくと、後で複数 grant に使い回せる。直接 CIDR で書くこともできる: `"dst": ["192.168.8.0/24:*"]`。
- `ip` には実際に使うプロトコルとポートを指定。HTTP なら `tcp:80`、HTTPS なら `tcp:443` など。雑に全部開けるなら `"ip": ["*"]` でも可 (推奨はしない)。
- 既存の grant を消さないように注意。

保存後、Tailscale はリアルタイムに ACL を全クライアントに配信します。

### ハマりポイント

- **grant が無いと netmap に subnet route が来ないことがある**: そのクライアントが ACL 上アクセスする可能性が無いサブネットは、coordinator が netmap から省くことがある (ACL ベースの netmap pruning)。subnet route が来ないとき、まずこの grant が入っているか確認する。
- **古い acls 形式と grants 形式の混在に注意**: Tailscale には旧来の `"acls"` 形式と新しい `"grants"` 形式があり、テナントごとにどちらか一方が使われる。既存ファイルが grants 形式なら追加も grants 形式で書く。Visual editor で書く方が事故が少ない。
- **JSON 末尾のカンマ**: Tailscale の policy file は JSONC (コメントと末尾カンマ許容) だが、構文ミスがあると保存時にエラーが出る。バナーを見逃さないこと。

---

## ステップ4b: デバイス → PC を許可する (デバイスが PC に接続する場合)

ステップ4は **PC → デバイス** (PC がデバイスに POST する向き) でした。アプリによっては
**デバイス → PC** の接続も必要です。例えば minimum-headroom では、対象デバイスが PC の
face-app WebSocket (既定 `:8765`) に **クライアントとして接続** してマイク音声 (VAD/PTT)
を PC へ送ります。この向きには別の grant が要ります。

```jsonc
{
    "hosts": {
        // PC の Tailscale IP (100.x の自ノードIP) に名前を付ける
        "apps-host": "<PC の Tailscale IP>"
    },

    "grants": [
        // 既存のルール...

        // (任意) 自分の tailnet "ノード" (スマホ/PC 等) から PC の face サービスへ。
        //  AtomS3R はノードではないのでこの grant は使わない (モバイル UI やテスト用)。
        //  既にこの grant があるなら ip 配列に "tcp:8765" を足すだけでよい。
        {
            "src": ["group:me"],
            "dst": ["host:apps-host"],
            "ip":  ["tcp:8765"]            // ← face-app のポート。他に使うポートがあれば併記
        },

        // ★必須★ トラベルルーター配下のデバイス (AtomS3R) から PC の face サービスへ。
        //  デバイスが繋がるにはこの subnet 指定の grant が要る (下のハマりポイント参照)。
        {
            "src": ["192.168.8.0/24"],    // ← トラベルルーターの LAN CIDR に置き換える
            "dst": ["host:apps-host"],
            "ip":  ["tcp:8765"]
        }
    ]
}
```

> **ポート補足**: `ip` に並ぶのは「PC 側で実際に使うサービスのポート」です。AtomS3R の
> face WS に必要なのは face-app のポート (既定 `8765`) **だけ**。既存の grant に他のポート
> (例: モバイル UI を Tailscale Serve の HTTPS で見るための `8443` など、別用途のポート) が
> あれば**消さずに残し**、`8765` を加えるだけにします。**AtomS3R に効くのは下の
> `192.168.8.0/24` の grant** で、`group:me` の grant は (AtomS3R の WS には) 無くても繋がり
> ます (こちらは tailnet ノードからのモバイル UI / テスト用)。

### 最大のハマりポイント (重要): src は「ノード」ではなく「LAN サブネット」

Tailscale 非対応デバイスが PC に接続するとき、**ルーターはデバイスの元の送信元 IP
(LAN の `192.168.8.x`) をそのまま中継** します (SNAT してルーター自身の Tailnet IP に
化けさせ *ない*)。そのため:

- `group:me` (= 自分の tailnet *ノード*) を src にした grant **だけでは届きません**。
  PC から見た送信元はノードの `100.x` ではなく `192.168.8.x` だからです。
- **`src` にトラベルルーターの LAN CIDR (`192.168.8.0/24`) を指定した grant が必須** です。
  Tailscale はサブネット CIDR を grant の src に受け付けます (advertise + approve 済みが前提)。

### 症状と確認

- **症状**: デバイスは WiFi に繋がっているのに PC への TCP/WebSocket 接続がタイムアウトする。
  デバイス側 `/health` は `ws_connected: false`。**ufw で `tailscale0` のポートを許可していても
  効かない** (Tailscale の ACL が OS firewall より *手前* で評価され、grant が無いと先に落とす)。
- **PC 側で許可状況を確認** — `packetFilter` にそのルールが出るか:
  ```bash
  tailscale debug netmap   # src=192.168.8.0/24, dst=自ノード, port=8765 のルールがあるか
  ```
- **接続を確認**:
  ```bash
  ss -tnp | grep :8765     # 192.168.8.x からの ESTAB が出れば成功
  ```

### なぜこの非対称が起きるのか

サブネットルーターの「LAN を advertise」は **tailnet → LAN (inbound)** を開けるだけです
(= PC → デバイスが通る理由)。**LAN → tailnet (outbound)** にあたるデバイス発の接続は、
ACL で LAN サブネットを src として明示しない限り通りません。「PC からは届くのにデバイス
からは届かない」ときは、まずこの逆方向 grant を疑ってください。

---

## ステップ5: PC 側で accept-routes を有効化する

PC の Tailscale クライアントは、デフォルトでは他ノードが advertise したサブネット route を **受け入れません**。明示的に有効化が必要です。

```bash
sudo tailscale set --accept-routes
```

もしくは、最初から有効にして繋ぎたい場合:

```bash
sudo tailscale up --accept-routes --operator=<username> [その他のフラグ]
```

`tailscale up` を再実行する際は、現在使っている全ての非デフォルトフラグを一緒に渡す必要があります (`--reset` で全リセットも可)。エラーメッセージで「explicitly mention the current value of all non-default settings」と出るので、その指示に従う。

### 確認方法

PC 側で:

```bash
tailscale debug netmap | grep -A2 "<トラベルルーターのホスト名>"
```

または:

```bash
ip route get <対象デバイスIP>
```

正常なら `dev tailscale0` 経由で出ていきます。

### 最大のハマりポイント (重要)

**`tailscale set --accept-routes` や `tailscale up --accept-routes` だけでは netmap が更新されないケースがある。** ステップ1〜4 を全部正しくやっても、PC の netmap の peer 情報に subnet route (`192.168.8.0/24`) が現れない症状がしばしば発生する。

その場合、**完全 logout/login で netmap をゼロから取り直す** と一発で解決する:

```bash
sudo tailscale logout
sudo tailscale up --accept-routes --operator=<username> [その他のフラグ]
```

`tailscale up` 実行時に表示される認証 URL をブラウザで開いて承認する。これで PC の Tailscale はゼロから netmap を取得し、subnet route も含まれてくる。

`tailscale down && tailscale up` ではなく **必ず `logout` から** やるのがポイント (`down/up` ではキャッシュが残ったまま再接続するため、症状が解消されないことがある)。

---

## ステップ6: 対象デバイスの IP を固定 + 疎通確認

### 対象デバイスの IP を固定

DHCP リース期限切れや再起動で IP が変わると、ACL や bridge 設定が全部使えなくなります。トラベルルーターの DHCP 設定で **静的リース (予約済み IP / Static Lease)** を設定して、対象デバイスの MAC アドレスに固定の IP を割り当てる。

### PC からの疎通確認

```bash
curl -m 5 http://<対象デバイスIP>/<エンドポイント>
ip route get <対象デバイスIP>
```

`ip route get` の出力が `dev tailscale0` 経由になっていれば Tailscale 経由で届いています。`dev eth0` や `dev wlan0` 等になっている場合は同じ LAN にいるので Tailscale を使っていません (それでも疎通自体は OK)。

---

## トラブルシュート: それでも届かない時の切り分け順

上から順にチェック:

1. **トラベルルーターは Tailscale 上で生きているか?**
   - PC で `tailscale ping <トラベルルーターのTailnet IP>` が pong を返すか。
2. **トラベルルーターは subnet を advertise しているか?**
   - トラベルルーターに SSH して `tailscale debug prefs | grep -A2 AdvertiseRoutes`。
3. **admin console で Approved になっているか?**
   - Machines → 対象ルーター → Subnets を見る。
4. **ACL に grant があるか?**
   - JSON editor で対象 IP/サブネット向けの grant が見えるか。
5. **PC の netmap に subnet route が来ているか?**
   - `tailscale debug netmap` で対象ピアの `AllowedIPs` を確認。`192.168.8.0/24` のようなサブネットが入っているか。
6. **来ていない場合 → ステップ5の logout/login** を実行。
7. **PC のカーネルルーティングが Tailscale を選んでいるか?**
   - `ip route get <対象デバイスIP>` の `dev` が `tailscale0` になっているか。
   - もし PC が両方のネットワークに繋がっている (例: 自宅 LAN + トラベルルーター WiFi) なら、より具体的なルートが優先される。
8. **対象デバイスが応答するか?**
   - 同じ LAN にいる別端末から `curl http://<対象デバイスIP>/` 等で疎通確認。デバイス自体の問題切り分け。
9. **デバイス → PC の接続が要る構成か? (例: 音声WS)**
   - その向きは別 grant が必要 (ステップ4b)。ACL に **LAN サブネットを src にした grant** があるか確認する。`group:me` (ノード) だけでは届かない。PC 側 `tailscale debug netmap` の `packetFilter` に該当ポートのルールが出ているかも見る。

---

## サブネット帯の選び方 (重要な事前検討)

PC の自宅 LAN とトラベルルーター LAN が **同じ CIDR** になっていると、Linux/macOS のルーティングは「より具体的なルート」を優先する原則で、自宅 LAN 側の直結ルートが Tailscale ルートに勝ってしまい、結果として対象デバイスに届きません。

例:
- 自宅 LAN: `192.168.1.0/24`
- トラベルルーター LAN: `192.168.1.0/24` ← **アウト**

GL.iNet のトラベルルーターはデフォルトで `192.168.8.0/24` を使うため、自宅 LAN が `192.168.1.0/24` や `192.168.0.0/24` ならそのままで衝突しません。もし自宅 LAN も `192.168.8.0/24` を使っている場合は、トラベルルーター側の LAN を別帯 (例 `192.168.50.0/24`) に変更してください。

---

## おまけ: アプリケーション側の URL 設定

サブネットルーティングが動けば、アプリケーション側 (例: minimum-headroom の AtomS3R HTTP bridge) は、対象デバイスの **LAN IP をそのまま** 設定して使えます。

```bash
export ATOM_HEADROOM_URL="http://192.168.8.100"
```

PC が自宅 LAN にいる時は Tailscale 経由、PC をトラベルルーターの WiFi に直接繋いだ時は LAN 直結、と **カーネルが自動で経路選択** してくれます。一つの URL 設定で両ケースカバーできるので、アプリケーション側で接続経路を分岐する必要はありません。

デバイスの IP が自宅 ⇄ トラベルで切り替わる場合、固定値の直書きだと追従できません。
minimum-headroom の bridge は `device_id` で対象を **自動発見** するので、トラベルルーターの
LAN 帯を探索対象に足しておけば手で書き換えずに済みます (直結インターフェースの帯は自動で
探索しますが、Tailscale 経由で *routed* な帯は明示が必要です):

```bash
# 直結インターフェース以外に探索したいサブネット (カンマ区切り)
export ATOM_HEADROOM_DISCOVERY_SUBNETS="192.168.8.0/24"
```

---

## 参考

- Tailscale 公式: Subnet routers <https://tailscale.com/kb/1019/subnets/>
- Tailscale 公式: ACL 構文 <https://tailscale.com/kb/1018/acls/>
- GL.iNet 公式ドキュメント (Tailscale): <https://docs.gl-inet.com/router/en/4/interface_guide/tailscale/>

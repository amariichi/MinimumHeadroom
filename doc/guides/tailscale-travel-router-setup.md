# Reach a non-Tailscale device through a Tailscale travel router / Tailscale 非対応デバイスをトラベルルーター経由で繋ぐ

<a id="english"></a>

## English

How to reach a small device that can't run a Tailscale client (like the AtomS3R / ESP32) from a Tailscale-equipped PC on a different network, by routing through a Tailscale-capable travel router (e.g. GL.iNet GL-MT3600BE). It uses **Tailscale subnet routing** (the subnet-router feature).

### Topology

```
[ Home LAN  192.168.1.0/24 ]                    [ Travel-router LAN  192.168.8.0/24 ]
                                                                  │
   PC (Tailscale) ───────── Tailscale ────────── Travel router (Tailscale)
                                                                  │
                                                        non-Tailscale device
                                                            (e.g. AtomS3R)
                                                              192.168.8.100
```

Goal: from the PC, reach a LAN IP like `http://192.168.8.100/` over Tailscale while the PC stays on the home LAN.

### Prerequisites

- The travel router has a built-in Tailscale client (GL.iNet 4.x firmware: GL-MT3600BE, GL-MT2500, …).
- You have a Tailscale account and can join both the PC and the router to the same tailnet.
- The target device is connected (wired/Wi-Fi) to the travel router's LAN.
- The router and the PC are on different physical LANs (subnet routing is unnecessary if they share a LAN).

### Overview

1. Join the travel router to Tailscale
2. Enable "LAN remote access" on the router (= advertise the LAN subnet)
3. Approve the advertised subnet in the Tailscale admin console
4. Add an ACL grant for "PC → target device"
5. Enable `--accept-routes` on the PC and refresh its netmap
6. Pin the device's IP and verify reachability from your app

### Step 1: Join the travel router to Tailscale

1. Open the router admin UI (`http://192.168.8.1/` etc.).
2. Go to **Applications → Tailscale**.
3. Turn **Enable** on.
4. Click **Bind account**, open the shown auth URL, and authorize with your Tailscale account.
5. After authorizing, the **router's virtual IP** (a `100.x.x.x` tailnet address) should appear.
6. Confirm the router appears under `admin.tailscale.com → Machines`.

Gotchas:

- **Stale nodes linger** — repeated re-binds/resets can leave old nodes with the same hostname in Machines; delete them, or they confuse later steps.
- **Key expiry** — nodes expire after 180 days by default. For long-term use, "Disable key expiry" for the node so it doesn't drop while you're away.

### Step 2: Advertise the LAN subnet

1. In the router's Tailscale page, turn **Allow Remote Access to LAN** on, then **Apply**.
2. Internally this runs `tailscale up --advertise-routes=<LAN subnet>`, advertising the router's LAN subnet (e.g. `192.168.8.0/24`).

Verify (optional), if you can SSH into the router (`ssh root@192.168.8.1` on GL.iNet):

```bash
tailscale debug prefs | grep -A2 AdvertiseRoutes
```

If `AdvertiseRoutes` is `["192.168.8.0/24"]` (not `null` / `[]`), it's advertised.

Gotchas:

- **The toggle alone isn't enough** — advertising doesn't make the route usable; it must be **Approved** (Step 3).
- **It can reset on restart/re-bind** — re-check this toggle after any re-bind.
- **"WAN remote access" / "Exit node" are different features** — leave them OFF for plain LAN reachability.

### Step 3: Approve the subnet in the admin console

1. In `admin.tailscale.com → Machines`, open the travel router.
2. Open **Subnets** (or the **…** menu → **Edit route settings**).
3. The advertised subnet (e.g. `192.168.8.0/24`) appears under **Awaiting Approval** — check it and save; it moves to **Approved**.

Gotchas:

- **Awaiting Approval empty** — the router isn't advertising yet; redo Step 2.
- **Approved but never reaches the client netmap** — it may be "approved once but not currently advertised"; re-check `AdvertiseRoutes` isn't empty.
- **Conflict with ACL `autoApprovers`** — a mismatch can stop it appearing at all; for a simple setup, avoid `autoApprovers`.

### Step 4: ACL — allow PC → target device

Open `admin.tailscale.com → Access controls` and add a grant. Example — let `group:me` reach TCP 80 on `192.168.8.100`:

```jsonc
{
    "hosts": {
        "atoms3r": "192.168.8.100"
    },

    "grants": [
        // existing rules...

        {
            "src": ["group:me"],
            "dst": ["host:atoms3r"],
            "ip":  ["tcp:80"]
        }
    ]
}
```

Notes:

- Naming the LAN IP in `hosts` lets you reuse it. You can also use a CIDR: `"dst": ["192.168.8.0/24:*"]`.
- Put the real protocol/port in `ip` (`tcp:80` HTTP, `tcp:443` HTTPS). `"ip": ["*"]` opens everything (not recommended).
- Don't delete existing grants. Tailscale distributes the ACL to all clients in real time on save.

Gotchas:

- **No grant → the subnet route may be pruned from the netmap** (ACL-based pruning). If the route doesn't arrive, check this grant first.
- **Old `acls` vs new `grants` format** — match whatever the file already uses; the visual editor is safer.
- **Trailing commas** — the file is JSONC, but a syntax error blocks save; watch for the banner.

### Step 4b: Allow device → PC (when the device connects to the PC)

Step 4 was **PC → device**. Some apps also need **device → PC**. In minimum-headroom, the device **connects as a client** to the PC's face-app WebSocket (default `:8765`) to send mic audio (VAD/PTT). That direction needs a separate grant.

```jsonc
{
    "hosts": {
        // name the PC's Tailscale IP (your own 100.x node IP)
        "apps-host": "<PC's Tailscale IP>"
    },

    "grants": [
        // existing rules...

        // (optional) from your tailnet "nodes" (phone/PC) to the PC's face service.
        //  The AtomS3R is not a node, so it doesn't use this grant (mobile UI / testing).
        //  If you already have it, just add "tcp:8765" to its ip list.
        {
            "src": ["group:me"],
            "dst": ["host:apps-host"],
            "ip":  ["tcp:8765"]            // ← face-app's port; keep any other ports you use
        },

        // *** required *** from the device behind the travel router (AtomS3R) to the PC.
        {
            "src": ["192.168.8.0/24"],    // ← replace with your travel router's LAN CIDR
            "dst": ["host:apps-host"],
            "ip":  ["tcp:8765"]
        }
    ]
}
```

> **Port note**: values in `ip` are ports of services that actually run on the PC. The AtomS3R face WS needs **only** the face-app port (default `8765`). If your existing grant has other ports (e.g. `8443` for a mobile UI via Tailscale Serve HTTPS — a different purpose), keep them and just add `8765`. **What matters for the AtomS3R is the `192.168.8.0/24` grant**; the `group:me` grant is not needed for the AtomS3R WS.

#### The key gotcha: `src` is the LAN subnet, not a node

When a non-Tailscale device connects to the PC, **the router relays the device's original source IP** (`192.168.8.x`) — it does **not** SNAT it to the router's tailnet IP. So:

- A grant with `src` = `group:me` (your tailnet *nodes*) **won't match** — the PC sees `192.168.8.x`, not a `100.x` node.
- **A grant with `src` = the travel router's LAN CIDR (`192.168.8.0/24`) is required.** Tailscale accepts a subnet CIDR as a grant `src` (given the route is advertised + approved).

#### Symptoms & checks

- **Symptom**: the device is on Wi-Fi but its TCP/WebSocket to the PC times out; the device's `/health` shows `ws_connected: false`. **Allowing the port on `tailscale0` in ufw doesn't help** — Tailscale's ACL is evaluated *before* the OS firewall.
- **Check the grant on the PC** — is the rule in `packetFilter`?
  ```bash
  tailscale debug netmap   # rule src=192.168.8.0/24, dst=this node, port=8765?
  ```
- **Check the connection**:
  ```bash
  ss -tnp | grep :8765     # an ESTAB from 192.168.8.x means success
  ```

#### Why the asymmetry

The subnet router's "advertise LAN" only opens **tailnet → LAN (inbound)** — that's why PC → device works. A device-initiated **LAN → tailnet (outbound)** connection won't pass unless the ACL names the LAN subnet as `src`. When "the PC reaches the device but the device can't reach the PC", suspect this reverse grant first.

### Step 5: Enable accept-routes on the PC

The PC's Tailscale client does **not** accept other nodes' advertised subnet routes by default:

```bash
sudo tailscale set --accept-routes
# or, from the start (pass all your current non-default flags too):
sudo tailscale up --accept-routes --operator=<username> [other flags]
```

Verify on the PC — `tailscale debug netmap | grep -A2 "<router hostname>"`, or `ip route get <device IP>` (going out `dev tailscale0` = routing over Tailscale).

**The key gotcha:** `--accept-routes` sometimes doesn't refresh the netmap — the subnet route (`192.168.8.0/24`) often fails to appear even with Steps 1–4 correct. A **full logout/login** refetches it and fixes it in one shot:

```bash
sudo tailscale logout
sudo tailscale up --accept-routes --operator=<username> [other flags]
```

Start from `logout`, **not** `tailscale down && tailscale up` (down/up reconnects with cached state and may not clear the symptom).

### Step 6: Pin the device IP + verify

Set a **static lease (reserved IP)** in the router's DHCP for the device's MAC — otherwise a DHCP change breaks the ACL and bridge config. Verify from the PC:

```bash
curl -m 5 http://<device IP>/<endpoint>
ip route get <device IP>          # dev tailscale0 = over Tailscale; dev eth0/wlan0 = same LAN
```

### Troubleshooting — order to isolate "still not reachable"

1. **Router alive on Tailscale?** — `tailscale ping <router tailnet IP>` returns pong?
2. **Router advertising the subnet?** — SSH: `tailscale debug prefs | grep -A2 AdvertiseRoutes`.
3. **Approved in the admin console?** — Machines → router → Subnets.
4. **ACL grant present?** — see the target IP/subnet grant in the JSON editor.
5. **Subnet route in the PC netmap?** — `tailscale debug netmap`, check the peer's `AllowedIPs` for `192.168.8.0/24`.
6. **If not → Step 5's logout/login.**
7. **PC kernel routing choosing Tailscale?** — `ip route get <device IP>` shows `dev tailscale0`? If the PC is on both networks, the more specific route wins.
8. **Device responds?** — `curl http://<device IP>/` from another host on the same LAN.
9. **Need device → PC?** (e.g. an audio WS) — needs a separate grant (Step 4b): the ACL must have a grant with the **LAN subnet as `src`** (`group:me` alone won't reach), and the rule must appear in the PC's `tailscale debug netmap` `packetFilter`.

### Choosing the subnet range (important upfront)

If the home LAN and the travel-router LAN use the **same CIDR**, routing prefers the more specific (directly-attached) route, so the home route beats the Tailscale route and the device is unreachable. Example bad pairing: home `192.168.1.0/24` + travel `192.168.1.0/24`. GL.iNet defaults to `192.168.8.0/24`, so a home LAN of `192.168.1.0/24` won't collide; if your home LAN is also `192.168.8.0/24`, change the travel-router LAN (e.g. `192.168.50.0/24`).

### Bonus: app-side URL config

Once subnet routing works, the app (e.g. minimum-headroom's AtomS3R HTTP bridge) can use the device's **LAN IP as-is**:

```bash
export ATOM_HEADROOM_URL="http://192.168.8.100"
```

On the home LAN it routes via Tailscale; plugged directly into the travel-router Wi-Fi it's a direct LAN hop — the kernel picks the route. One URL covers both. If the device IP flips between home ⇄ travel, the bridge **auto-discovers** it by `device_id`; add the travel-router range to its discovery list (directly-attached ranges are swept automatically, but a Tailscale-*routed* range must be listed):

```bash
export ATOM_HEADROOM_DISCOVERY_SUBNETS="192.168.8.0/24"
```

### References

- Tailscale: Subnet routers <https://tailscale.com/kb/1019/subnets/>
- Tailscale: ACL syntax <https://tailscale.com/kb/1018/acls/>
- GL.iNet docs (Tailscale): <https://docs.gl-inet.com/router/en/4/interface_guide/tailscale/>

---

<a id="japanese"></a>

## 日本語

AtomS3R (ESP32) のように Tailscale クライアントが入らない小型デバイスを、Tailscale 対応のトラベルルーター (GL.iNet GL-MT3600BE 等) を経由して、別ネットワークにいる Tailscale 入りの PC から到達できるようにする手順をまとめます。

「Tailscale のサブネットルーティング（サブネットルーター機能）」を使う構成です。

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
- トラベルルーターと PC が異なる物理 LAN にいる前提 (同じ LAN にいるならサブネットルーティングは不要)。

---

## 全体の流れ

1. トラベルルーターを Tailscale に参加させる
2. トラベルルーターで「LAN リモートアクセス」を有効化（= LAN サブネットを Tailscale に公開）
3. Tailscale 管理コンソールで公開されたサブネットを承認
4. ACL に「PC → 対象デバイス」を許可する grant ルールを追加
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

- **古いノードが残ることがある**: 再バインドや初期化を繰り返すと、Machines に同じホスト名の古いノードが残る。古いノードは管理コンソールで削除する。古いノードが残っていると、後段で混乱の元になる。
- **キー期限**: デフォルトで 180 日後に key expiry がある。長期運用するなら管理コンソールで当該ノードを「Disable key expiry」しておくと、外出先で突然繋がらなくなる事故を防げる。

---

## ステップ2: LAN サブネットを公開する

1. トラベルルーター管理画面 → Tailscale 画面で「**LAN のリモートアクセスを許可する**」トグルを ON。
2. 「**適用**」または「Apply」ボタンを押す。
3. これで内部的に `tailscale up --advertise-routes=<LANサブネット>` が走り、トラベルルーターの LAN サブネット (例 `192.168.8.0/24`) が Tailscale に公開される。

### 確認方法 (任意)

SSH でトラベルルーターに入れる場合 (GL.iNet なら `ssh root@192.168.8.1`):

```bash
tailscale debug prefs | grep -A2 AdvertiseRoutes
```

`AdvertiseRoutes` が `null` や `[]` ではなく `["192.168.8.0/24"]` のようになっていれば公開されています。

### ハマりポイント

- **トグル ON だけでは不完全**: 公開しただけではサブネットルートは使えません。管理コンソールでの承認（ステップ3）が必須。
- **トグル ON 後の再起動/再バインドでリセットされることがある**: Tailscale 自体を再起動したり、アカウントを再バインドした場合、トラベルルーターのファームウェア仕様によっては LAN 公開設定が外れることがある。再バインド後は必ずこのトグルを確認する。
- **WAN リモートアクセスは別物**: 「WAN リモートアクセスを許可」は WAN 側 IP に Tailnet からアクセスさせる別機能。LAN 越しに繋ぎたいだけなら OFF のままで OK。
- **Exit Node も別物**: Exit Node を ON にすると Tailnet 全ノードのインターネット出口にできる機能。LAN デバイス到達には無関係なので OFF のまま。

---

## ステップ3: 管理コンソールでサブネットを承認

1. `admin.tailscale.com → Machines` で対象のトラベルルーターを開く。
2. **Subnets** セクション (または右側「…」メニュー → **Edit route settings**) を開く。
3. 「**Awaiting Approval**」欄に `192.168.8.0/24` (など公開されたサブネット) が表示されているはず。チェックボックスを ON にして保存。
4. 保存後、「**Approved**」欄に移動すれば成功。

### ハマりポイント

- **Awaiting Approval が空の場合**: トラベルルーター側でまだ公開処理が走っていない。ステップ2 をやり直す (トグル OFF → 適用 → ON → 適用、または Tailscale 自体を再起動)。
- **Approved に表示されているのに後述のクライアント netmap に来ない場合**: 「過去に承認したが現在は公開していない」状態のことがある。トラベルルーター側で `AdvertiseRoutes` が空になっていないかステップ2の確認方法で見る。
- **ACL の自動承認との衝突**: ACL に `autoApprovers` を書いている場合、その内容と矛盾していると Awaiting Approval にすら出ない。シンプルな構成では `autoApprovers` を使わない方が分かりやすい。

---

## ステップ4: ACL で PC → 対象デバイスを許可する

`admin.tailscale.com → Access controls` を開き、JSON エディタで grant ルールを追加します。

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

- `hosts` で LAN IP に名前を付けておくと、後で複数の grant ルールに使い回せる。直接 CIDR で書くこともできる: `"dst": ["192.168.8.0/24:*"]`。
- `ip` には実際に使うプロトコルとポートを指定。HTTP なら `tcp:80`、HTTPS なら `tcp:443` など。雑に全部開けるなら `"ip": ["*"]` でも可 (推奨はしない)。
- 既存の grant ルールを消さないように注意。

保存後、Tailscale はリアルタイムに ACL を全クライアントに配信します。

### ハマりポイント

- **grant ルールが無いと netmap にサブネットルートが来ないことがある**: そのクライアントが ACL 上アクセスする可能性が無いサブネットは、coordinator が netmap から省くことがある（ACL ベースの netmap pruning）。サブネットルートが来ないとき、まずこの grant ルールが入っているか確認する。
- **古い acls 形式と grants 形式の混在に注意**: Tailscale には旧来の `"acls"` 形式と新しい `"grants"` 形式があり、テナントごとにどちらか一方が使われる。既存ファイルが grants 形式なら追加も grants 形式で書く。Visual editor で書く方が事故が少ない。
- **JSON 末尾のカンマ**: Tailscale のポリシーファイルは JSONC（コメントと末尾カンマ許容）だが、構文ミスがあると保存時にエラーが出る。バナーを見逃さないこと。

---

## ステップ4b: デバイス → PC を許可する (デバイスが PC に接続する場合)

ステップ4は **PC → デバイス** (PC がデバイスに POST する向き) でした。アプリによっては
**デバイス → PC** の接続も必要です。例えば minimum-headroom では、対象デバイスが PC の
face-app WebSocket (既定 `:8765`) に **クライアントとして接続** してマイク音声 (VAD/PTT)
を PC へ送ります。この向きには別の grant ルールが要ります。

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
        //  デバイスが繋がるにはこのサブネット指定の grant が要る (下のハマりポイント参照)。
        {
            "src": ["192.168.8.0/24"],    // ← トラベルルーターの LAN CIDR に置き換える
            "dst": ["host:apps-host"],
            "ip":  ["tcp:8765"]
        }
    ]
}
```

> **ポート補足**: `ip` に並ぶのは「PC 側で実際に使うサービスのポート」です。AtomS3R の
> face WS に必要なのは face-app のポート (既定 `8765`) **だけ**。既存の grant ルールに他のポート
> (例: モバイル UI を Tailscale Serve の HTTPS で見るための `8443` など、別用途のポート) が
> あれば**消さずに残し**、`8765` を加えるだけにします。**AtomS3R に効くのは下の
> `192.168.8.0/24` の grant ルール** で、`group:me` の grant ルールは (AtomS3R の WS には) 無くても繋がり
> ます (こちらは tailnet ノードからのモバイル UI / テスト用)。

### 最大のハマりポイント (重要): src は「ノード」ではなく「LAN サブネット」

Tailscale 非対応デバイスが PC に接続するとき、**ルーターはデバイスの元の送信元 IP
(LAN の `192.168.8.x`) をそのまま中継** します (SNAT してルーター自身の Tailnet IP に
化けさせ *ない*)。そのため:

- `group:me` (= 自分の tailnet *ノード*) を src にした grant ルールだけでは届きません。
  PC から見た送信元はノードの `100.x` ではなく `192.168.8.x` だからです。
- **`src` にトラベルルーターの LAN CIDR (`192.168.8.0/24`) を指定した grant ルールが必須** です。
  Tailscale はサブネット CIDR を grant の src に受け付けます（公開 + 承認済みが前提）。

### 症状と確認

- **症状**: デバイスは WiFi に繋がっているのに PC への TCP/WebSocket 接続がタイムアウトする。
  デバイス側 `/health` は `ws_connected: false`。**ufw で `tailscale0` のポートを許可していても
  効かない** (Tailscale の ACL が OS ファイアウォールより *手前* で評価され、grant ルールが無いと先に落とす)。
- **PC 側で許可状況を確認** — `packetFilter` にそのルールが出るか:
  ```bash
  tailscale debug netmap   # src=192.168.8.0/24, dst=自ノード, port=8765 のルールがあるか
  ```
- **接続を確認**:
  ```bash
  ss -tnp | grep :8765     # 192.168.8.x からの ESTAB が出れば成功
  ```

### なぜこの非対称が起きるのか

サブネットルーターの「LAN を公開」は **tailnet → LAN (inbound)** を開けるだけです
(= PC → デバイスが通る理由)。**LAN → tailnet (outbound)** にあたるデバイス発の接続は、
ACL で LAN サブネットを src として明示しない限り通りません。「PC からは届くのにデバイス
からは届かない」ときは、まずこの逆方向の grant ルールを疑ってください。

---

## ステップ5: PC 側で accept-routes を有効化する

PC の Tailscale クライアントは、デフォルトでは他ノードが公開したサブネットルートを **受け入れません**。明示的に有効化が必要です。

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

**`tailscale set --accept-routes` や `tailscale up --accept-routes` だけでは netmap が更新されないケースがある。** ステップ1〜4 を全部正しくやっても、PC の netmap のピア情報にサブネットルート (`192.168.8.0/24`) が現れない症状がしばしば発生する。

その場合、**完全 logout/login で netmap をゼロから取り直す** と一発で解決する:

```bash
sudo tailscale logout
sudo tailscale up --accept-routes --operator=<username> [その他のフラグ]
```

`tailscale up` 実行時に表示される認証 URL をブラウザで開いて承認する。これで PC の Tailscale はゼロから netmap を取得し、サブネットルートも含まれてくる。

`tailscale down && tailscale up` ではなく **必ず `logout` から** やるのがポイント (`down/up` ではキャッシュが残ったまま再接続するため、症状が解消されないことがある)。

---

## ステップ6: 対象デバイスの IP を固定 + 疎通確認

### 対象デバイスの IP を固定

DHCP リース期限切れや再起動で IP が変わると、ACL やブリッジ設定が全部使えなくなります。トラベルルーターの DHCP 設定で **静的リース (予約済み IP / Static Lease)** を設定して、対象デバイスの MAC アドレスに固定の IP を割り当てる。

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
2. **トラベルルーターはサブネットを公開しているか?**
   - トラベルルーターに SSH して `tailscale debug prefs | grep -A2 AdvertiseRoutes`。
3. **admin console で Approved になっているか?**
   - Machines → 対象ルーター → Subnets を見る。
4. **ACL に grant ルールがあるか?**
   - JSON エディタで対象 IP/サブネット向けの grant ルールが見えるか。
5. **PC の netmap にサブネットルートが来ているか?**
   - `tailscale debug netmap` で対象ピアの `AllowedIPs` を確認。`192.168.8.0/24` のようなサブネットが入っているか。
6. **来ていない場合 → ステップ5の logout/login** を実行。
7. **PC のカーネルルーティングが Tailscale を選んでいるか?**
   - `ip route get <対象デバイスIP>` の `dev` が `tailscale0` になっているか。
   - もし PC が両方のネットワークに繋がっている (例: 自宅 LAN + トラベルルーター WiFi) なら、より具体的なルートが優先される。
8. **対象デバイスが応答するか?**
   - 同じ LAN にいる別端末から `curl http://<対象デバイスIP>/` 等で疎通確認。デバイス自体の問題切り分け。
9. **デバイス → PC の接続が要る構成か? (例: 音声WS)**
   - その向きは別 grant ルールが必要 (ステップ4b)。ACL に **LAN サブネットを src にした grant ルール** があるか確認する。`group:me` (ノード) だけでは届かない。PC 側 `tailscale debug netmap` の `packetFilter` に該当ポートのルールが出ているかも見る。

---

## サブネット帯の選び方 (重要な事前検討)

PC の自宅 LAN とトラベルルーター LAN が **同じ CIDR** になっていると、Linux/macOS のルーティングは「より具体的なルート」を優先する原則で、自宅 LAN 側の直結ルートが Tailscale ルートに勝ってしまい、結果として対象デバイスに届きません。

例:
- 自宅 LAN: `192.168.1.0/24`
- トラベルルーター LAN: `192.168.1.0/24` ← **アウト**

GL.iNet のトラベルルーターはデフォルトで `192.168.8.0/24` を使うため、自宅 LAN が `192.168.1.0/24` や `192.168.0.0/24` ならそのままで衝突しません。もし自宅 LAN も `192.168.8.0/24` を使っている場合は、トラベルルーター側の LAN を別帯 (例 `192.168.50.0/24`) に変更してください。

---

## おまけ: アプリケーション側の URL 設定

サブネットルーティングが動けば、アプリケーション側 (例: minimum-headroom の AtomS3R HTTP ブリッジ) は、対象デバイスの **LAN IP をそのまま** 設定して使えます。

```bash
export ATOM_HEADROOM_URL="http://192.168.8.100"
```

PC が自宅 LAN にいる時は Tailscale 経由、PC をトラベルルーターの WiFi に直接繋いだ時は LAN 直結、と **カーネルが自動で経路選択** してくれます。一つの URL 設定で両ケースカバーできるので、アプリケーション側で接続経路を分岐する必要はありません。

デバイスの IP が自宅 ⇄ トラベルで切り替わる場合、固定値の直書きだと追従できません。
minimum-headroom のブリッジは `device_id` で対象を **自動発見** するので、トラベルルーターの
LAN 帯を探索対象に足しておけば手で書き換えずに済みます (直結インターフェースの帯は自動で
探索しますが、Tailscale 経由で経路設定された帯は明示が必要です):

```bash
# 直結インターフェース以外に探索したいサブネット (カンマ区切り)
export ATOM_HEADROOM_DISCOVERY_SUBNETS="192.168.8.0/24"
```

---

## 参考

- Tailscale 公式: Subnet routers <https://tailscale.com/kb/1019/subnets/>
- Tailscale 公式: ACL 構文 <https://tailscale.com/kb/1018/acls/>
- GL.iNet 公式ドキュメント (Tailscale): <https://docs.gl-inet.com/router/en/4/interface_guide/tailscale/>

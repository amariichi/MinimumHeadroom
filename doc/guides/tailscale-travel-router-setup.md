# Reach a non-Tailscale device through a Tailscale travel router / Tailscale 非対応デバイスへトラベルルーター経由で接続する

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

このガイドでは、AtomS3R（ESP32）のように Tailscale クライアントを導入できない小型デバイスへ、
別のネットワークにいる PC から接続する方法を説明します。Tailscale 対応のトラベルルーター
（GL.iNet GL-MT3600BE など）を中継に使います。

利用するのは、Tailscale のサブネットルーティング（サブネットルーター機能）です。

---

### 想定構成

```
[ 自宅LAN  192.168.1.0/24 ]                     [ トラベルルーターLAN  192.168.8.0/24 ]
                                                                  │
   PC (Tailscale入り) ───── Tailscale ─────── トラベルルーター (Tailscale入り)
                                                                  │
                                                          非Tailscaleデバイス
                                                            (例: AtomS3R)
                                                              192.168.8.100
```

目的は、自宅 LAN にいる PC から `http://192.168.8.100/` のような遠隔地の LAN IP へ、
Tailscale 経由で接続できるようにすることです。

---

### 前提

- トラベルルーターが Tailscale クライアントを内蔵していること（GL.iNet 4.x ファームウェアの
  GL-MT3600BE、GL-MT2500 など）。
- Tailscale アカウントを持っていて、PC とトラベルルーターを同じ Tailnet に参加させられること。
- 接続したいデバイスが、トラベルルーターの LAN 側に有線または Wi-Fi で接続されていること。
- トラベルルーターと PC が異なる物理 LAN にいること。同じ LAN にいる場合、
  サブネットルーティングは不要です。

---

### 全体の流れ

1. トラベルルーターを Tailscale に参加させます。
2. トラベルルーターで「LAN リモートアクセス」を有効にし、LAN サブネットを Tailscale へ
   公開します。
3. Tailscale 管理コンソールで、公開されたサブネットを承認します。
4. ACL に「PC → 対象デバイス」を許可する grant ルールを追加します。
5. PC 側で `--accept-routes` を有効にし、netmap を取得し直します。
6. 対象デバイスの IP を固定し、アプリケーションから疎通を確認します。

各ステップで詰まりやすいポイントを後述します。

---

### ステップ1: トラベルルーターを Tailscale に参加させる

1. トラベルルーターの管理画面（`http://192.168.8.1/` など）を開きます。
2. **アプリケーション → Tailscale** を開きます。
3. 「**有効化**」をオンにします。
4. 「**アカウントをバインドする**」を押します。表示された認証 URL をブラウザで開き、
   Tailscale アカウントで認可します。
5. 認可後、画面に **ルーターの仮想 IP**（`100.x.x.x` の tailnet アドレス）が表示されることを
   確認します。
6. `admin.tailscale.com → Machines` にトラベルルーターが表示されることを確認します。

#### つまずきやすい点

- **古いノードが残ることがある**: 再バインドや初期化を繰り返すと、Machines に同じ
  ホスト名の古いノードが残ることがあります。後の手順で取り違えないよう、古いノードは
  管理コンソールから削除してください。
- **キーに有効期限がある**: 既定では、キーは180日後に期限切れになります。長期間運用する
  場合は、管理コンソールで対象ノードの「Disable key expiry」を有効にしておくと、外出先で
  突然接続できなくなる事態を防げます。

---

### ステップ2: LAN サブネットを公開する

1. トラベルルーターの管理画面で Tailscale を開き、
   「**LAN のリモートアクセスを許可する**」をオンにします。
2. 「**適用**」または「Apply」を押します。
3. 内部で `tailscale up --advertise-routes=<LANサブネット>` が実行され、トラベルルーターの
   LAN サブネット（例: `192.168.8.0/24`）が Tailscale へ公開されます。

#### 確認方法（任意）

SSH でトラベルルーターへ接続できる場合は、次を実行します。GL.iNet の例は
`ssh root@192.168.8.1` です。

```bash
tailscale debug prefs | grep -A2 AdvertiseRoutes
```

`AdvertiseRoutes` が `null` や `[]` ではなく `["192.168.8.0/24"]` のようになっていれば公開されています。

#### つまずきやすい点

- **オンにするだけでは使えない**: サブネットを公開しただけではルートを利用できません。
  ステップ3で管理コンソールから承認する必要があります。
- **トグルをオンにした後の再起動や再バインドでリセットされることがある**: Tailscale 自体を
  再起動したり、アカウントを再バインドしたりすると、トラベルルーターのファームウェアに
  よっては LAN 公開設定が外れることがあります。再バインド後は、必ずこのトグルを確認して
  ください。
- **WAN リモートアクセスは別の機能**: 「WAN リモートアクセスを許可」は、tailnet から
  WAN 側 IP へ接続するための設定です。LAN 内のデバイスへ接続するだけならオフのままにします。
- **Exit Node も別の機能**: Exit Node は、tailnet 上のノードから出るインターネット通信の
  出口としてルーターを使う機能です。LAN デバイスへの接続には不要なので、オフのままにします。

---

### ステップ3: 管理コンソールでサブネットを承認する

1. `admin.tailscale.com → Machines` で対象のトラベルルーターを開きます。
2. **Subnets** セクション（または右側の「…」メニュー → **Edit route settings**）を開きます。
3. 「**Awaiting Approval**」欄に `192.168.8.0/24` などの公開されたサブネットが表示されている
   ことを確認し、チェックを入れて保存します。
4. 保存後に「**Approved**」欄へ移動すれば成功です。

#### つまずきやすい点

- **Awaiting Approval が空の場合**: トラベルルーター側で公開処理がまだ行われていません。
  ステップ2をやり直します（オフ → 適用 → オン → 適用、または Tailscale 自体を再起動）。
- **Approved に表示されているのに、後述するクライアントの netmap に届かない場合**:
  過去に承認したものの、現在は公開されていない可能性があります。ステップ2の確認方法を使い、
  トラベルルーター側の `AdvertiseRoutes` が空になっていないか確認してください。
- **ACL の自動承認との衝突**: ACL に `autoApprovers` を設定している場合、内容が矛盾すると
  Awaiting Approval に表示されないこともあります。単純な構成では、`autoApprovers` を
  使わないほうが分かりやすくなります。

---

### ステップ4: ACL で PC → 対象デバイスを許可する

`admin.tailscale.com → Access controls` を開き、JSON エディタで grant ルールを追加します。

例として、`group:me` に属するユーザーが `192.168.8.100`（AtomS3R など）の TCP 80 番ポートへ
接続できるルールを示します。

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

設定上の注意:

- `hosts` で LAN IP に名前を付けると、複数の grant ルールから再利用できます。CIDR を直接
  指定する場合は `"dst": ["192.168.8.0/24:*"]` のように書きます。
- `ip` には、実際に使うプロトコルとポートを指定します。HTTP なら `tcp:80`、HTTPS なら
  `tcp:443` です。`"ip": ["*"]` ですべて許可することもできますが、推奨しません。
- 既存の grant ルールは削除せず、必要なルールを追加してください。

保存後、Tailscale はリアルタイムに ACL を全クライアントに配信します。

#### つまずきやすい点

- **grant ルールがないと netmap にサブネットルートが届かないことがある**: ACL 上でアクセス
  できないサブネットは、coordinator が netmap から省くことがあります（ACL に基づく netmap
  pruning）。サブネットルートが届かない場合は、まず grant ルールを確認してください。
- **古い acls 形式と grants 形式を混在させない**: Tailscale には従来の `"acls"` 形式と
  新しい `"grants"` 形式があり、テナントごとにいずれかを使います。既存ファイルが grants
  形式なら、追加するルールも grants 形式で書きます。Visual editor を使うと構文ミスを
  避けやすくなります。
- **JSON 末尾のカンマ**: Tailscale のポリシーファイルは JSONC なので、コメントと末尾のカンマを
  使用できます。ただし、構文に誤りがあると保存時にエラーが表示されます。画面上部のバナーを
  見落とさないでください。

---

### ステップ4b: デバイス → PC を許可する（デバイスが PC に接続する場合）

ステップ4で許可したのは、**PC → デバイス**（PC がデバイスへ POST する向き）です。
アプリケーションによっては、
**デバイス → PC** の接続も必要です。例えば minimum-headroom では、対象デバイスが PC の
face-app WebSocket（既定 `:8765`）へ**クライアントとして接続**し、マイク音声（VAD/PTT）を
PC へ送ります。この向きには、別の grant ルールが必要です。

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
        //  デバイスの接続には、このサブネットを指定した grant が必要 (下の注意点を参照)。
        {
            "src": ["192.168.8.0/24"],    // ← トラベルルーターの LAN CIDR に置き換える
            "dst": ["host:apps-host"],
            "ip":  ["tcp:8765"]
        }
    ]
}
```

> **ポートについて:** `ip` に指定するのは、PC 側で実際に使うサービスのポートです。
> AtomS3R の face WebSocket に必要なのは、face-app のポート（既定 `8765`）だけです。
> 既存の grant ルールに別用途のポート、例えば Tailscale Serve の HTTPS でモバイル UI を
> 開くための `8443` がある場合は、削除せずに `8765` を追加します。
>
> AtomS3R からの接続に必要なのは、`192.168.8.0/24` を送信元にした grant ルールです。
> `group:me` のルールは、tailnet ノードからモバイル UI やテスト用サービスへ接続するための
> ものであり、AtomS3R の WebSocket 接続には必須ではありません。

#### 最も重要な注意点：src は「ノード」ではなく「LAN サブネット」

Tailscale 非対応デバイスが PC に接続するとき、**ルーターはデバイス本来の送信元 IP
（LAN の `192.168.8.x`）を保ったまま中継**します。SNAT でルーター自身の tailnet IP に
置き換えるわけではありません。そのため、次の点に注意が必要です。

- `group:me`（自分の tailnet *ノード*）だけを src にした grant ルールでは届きません。
  PC から見た送信元はノードの `100.x` ではなく `192.168.8.x` だからです。
- **`src` にトラベルルーターの LAN CIDR (`192.168.8.0/24`) を指定した grant ルールが必須** です。
  Tailscale は、公開・承認済みのサブネット CIDR を grant の src として受け付けます。

#### 症状と確認

- **症状**: デバイスは Wi-Fi に接続しているのに、PC への TCP/WebSocket 接続が
  タイムアウトします。
  デバイス側 `/health` は `ws_connected: false` になります。**ufw で `tailscale0` のポートを
  許可していても効果はありません**。Tailscale の ACL は OS ファイアウォールより前に評価され、
  grant ルールがなければ、そこで遮断されるためです。
- **PC 側で許可状況を確認** — `packetFilter` に対象ルールが現れるか確認します。
  ```bash
  tailscale debug netmap   # src=192.168.8.0/24, dst=自ノード, port=8765 のルールがあるか
  ```
- **接続を確認**:
  ```bash
  ss -tnp | grep :8765     # 192.168.8.x からの ESTAB が出れば成功
  ```

#### なぜこの非対称が起きるのか

サブネットルーターの「LAN を公開」は、**tailnet → LAN（inbound）** の方向を開くだけです。
これが PC → デバイスの接続を通せる理由です。**LAN → tailnet（outbound）** にあたる
デバイス発の接続は、
ACL で LAN サブネットを src として明示しない限り通りません。「PC からは届くのにデバイス
からは届かない」ときは、まずこの逆方向の grant ルールを疑ってください。

---

### ステップ5: PC 側で accept-routes を有効化する

PC の Tailscale クライアントは、既定では他のノードが公開したサブネットルートを
**受け入れません**。明示的に有効化してください。

```bash
sudo tailscale set --accept-routes
```

最初から有効にして接続する場合は、次のように起動します。

```bash
sudo tailscale up --accept-routes --operator=<username> [その他のフラグ]
```

`tailscale up` を再実行するときは、現在使用中の既定値以外のフラグをすべて一緒に渡す必要が
あります。すべて既定値へ戻すなら `--reset` も使えます。エラーに
`explicitly mention the current value of all non-default settings` と表示された場合は、その指示に
従ってください。

#### 確認方法

PC 側で:

```bash
tailscale debug netmap | grep -A2 "<トラベルルーターのホスト名>"
```

または:

```bash
ip route get <対象デバイスIP>
```

正常なら `dev tailscale0` 経由で出ていきます。

#### 重要：設定だけでは netmap が更新されない場合

**`tailscale set --accept-routes` や `tailscale up --accept-routes` だけでは、netmap が更新されない
場合があります。** ステップ1〜4がすべて正しくても、PC の netmap にあるピア情報へ
サブネットルート（`192.168.8.0/24`）が現れないことがあります。

その場合は、**完全にログアウトしてからログインし直し、netmap を最初から取得**します。

```bash
sudo tailscale logout
sudo tailscale up --accept-routes --operator=<username> [その他のフラグ]
```

`tailscale up` が表示する認証 URL をブラウザで開き、接続を承認します。PC の Tailscale は
netmap を最初から取得し直すため、サブネットルートも含まれるようになります。

ここでは `tailscale down` と `tailscale up` の組み合わせではなく、**`logout` から始める**ことが
重要です。`down/up` ではキャッシュを残したまま再接続するため、症状が解消しない場合があります。

---

### ステップ6: 対象デバイスの IP を固定して疎通を確認する

#### 対象デバイスの IP を固定

DHCP リースの期限切れや再起動で IP が変わると、ACL やブリッジの設定が使えなくなります。
トラベルルーターの DHCP 設定で**静的リース（予約済み IP / Static Lease）**を作り、対象デバイスの
MAC アドレスへ固定 IP を割り当ててください。

#### PC からの疎通確認

```bash
curl -m 5 http://<対象デバイスIP>/<エンドポイント>
ip route get <対象デバイスIP>
```

`ip route get` の出力が `dev tailscale0` 経由なら、Tailscale を通って届いています。
`dev eth0` や `dev wlan0` などの場合は同じ LAN へ直接接続しており、Tailscale は使っていません。
その場合でも、疎通できていれば通信自体は正常です。

---

### トラブルシュート: 接続できないときの確認順

上から順に確認してください。

1. **トラベルルーターは Tailscale に接続していますか？**
   - PC で `tailscale ping <トラベルルーターのTailnet IP>` を実行し、pong が返ることを確認します。
2. **トラベルルーターはサブネットを公開していますか？**
   - トラベルルーターへ SSH で接続し、`tailscale debug prefs | grep -A2 AdvertiseRoutes` を
     実行します。
3. **管理コンソールで Approved になっていますか？**
   - Machines → 対象ルーター → Subnets の順に開いて確認します。
4. **ACL に grant ルールがありますか？**
   - JSON エディタで、対象 IP またはサブネット向けの grant ルールを確認します。
5. **PC の netmap にサブネットルートが届いていますか？**
   - `tailscale debug netmap` で対象ピアの `AllowedIPs` を確認し、`192.168.8.0/24` のような
     サブネットが含まれていることを確かめます。
6. **届いていない場合**
   - ステップ5のログアウトと再ログインを実行します。
7. **PC のカーネルルーティングは Tailscale を選んでいますか？**
   - `ip route get <対象デバイスIP>` の `dev` が `tailscale0` になっていることを確認します。
   - PC が自宅 LAN とトラベルルーターの Wi-Fi など、両方のネットワークへ接続している場合は、
     より具体的なルートが優先されます。
8. **対象デバイス自体は応答しますか？**
   - 同じ LAN にいる別端末から `curl http://<対象デバイスIP>/` などを実行し、デバイス自体の
     問題かどうかを切り分けます。
9. **デバイス → PC の接続が必要な構成ですか？（例: 音声 WebSocket）**
   - この向きには、ステップ4bの別の grant ルールが必要です。ACL に **LAN サブネットを src に
     した grant ルール**があることを確認します。`group:me`（ノード）だけでは届きません。
     PC 側の `tailscale debug netmap` にある `packetFilter` で、対象ポートのルールも確認します。

---

### サブネット帯の選び方（重要な事前検討）

PC の自宅 LAN とトラベルルーター LAN が **同じ CIDR** になっていると、対象デバイスへ
到達できません。Linux と macOS は、より具体的なルートを優先するため、自宅 LAN 側の直結
ルートが Tailscale のルートより優先されるからです。

例:
- 自宅 LAN: `192.168.1.0/24`
- トラベルルーター LAN: `192.168.1.0/24` ← **同じため使用不可**

GL.iNet のトラベルルーターは、既定で `192.168.8.0/24` を使います。自宅 LAN が
`192.168.1.0/24` や `192.168.0.0/24` なら、そのままでも衝突しません。自宅 LAN も
`192.168.8.0/24` を使っている場合は、トラベルルーター側の LAN を別の範囲、例えば
`192.168.50.0/24` へ変更してください。

---

### アプリケーション側の URL 設定

サブネットルーティングが動けば、アプリケーション側、例えば minimum-headroom の
AtomS3R HTTP ブリッジには、対象デバイスの **LAN IP をそのまま**設定できます。

```bash
export ATOM_HEADROOM_URL="http://192.168.8.100"
```

PC が自宅 LAN にいるときは Tailscale 経由、PC がトラベルルーターの Wi-Fi に直接接続して
いるときは LAN 直結というように、**カーネルが自動的に経路を選びます**。一つの URL 設定で
両方に対応できるため、アプリケーション側で接続経路を分岐する必要はありません。

デバイスの IP が自宅 ⇄ トラベルで切り替わる場合、固定値の直書きだと追従できません。
minimum-headroom のブリッジは `device_id` で対象を **自動発見** するので、トラベルルーターの
LAN 帯を探索対象に追加しておけば、手動で書き換えずに済みます。直結インターフェースの帯は
自動的に探索しますが、Tailscale 経由で経路が設定された帯は明示する必要があります。

```bash
# 直結インターフェース以外に探索したいサブネット (カンマ区切り)
export ATOM_HEADROOM_DISCOVERY_SUBNETS="192.168.8.0/24"
```

---

### 参考

- Tailscale 公式: Subnet routers <https://tailscale.com/kb/1019/subnets/>
- Tailscale 公式: ACL 構文 <https://tailscale.com/kb/1018/acls/>
- GL.iNet 公式ドキュメント (Tailscale): <https://docs.gl-inet.com/router/en/4/interface_guide/tailscale/>

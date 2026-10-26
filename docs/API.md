# AntifieldCloud 瀵规帴濂戠害锛圠ofii Bot锛?
> 鏈枃鍙弿杩?lofii-bot 渚х殑绋冲畾鎺ュ彛銆?*鏈細璇濅笉淇敼 AntifieldCloud 浠撳簱/鏈嶅姟**锛汿oken 娉ㄥ叆銆侀潰鏉垮睍绀轰笌璋冪敤閫昏緫鐢辩敤鎴疯嚜琛屾帴鍏ャ€?
## 1. 鍩虹淇℃伅

| 椤圭洰 | 鍊?|
|---|---|
| Base URL | `http://127.0.0.1:3010`锛堜粎鍥炵幆锛屼笉瀵瑰寮€鏀撅級 |
| 閴存潈 | `Authorization: Bearer <HTTP_TOKEN>`锛坄/healthz` 闄ゅ锛?|
| Token 浣嶇疆 | Pi锛歚/etc/lofii-bot/env` 鐨?`HTTP_TOKEN`锛坮oot:lofiibot 0640锛?|
| 鏁版嵁鏍煎紡 | JSON锛孶TF-8 |
| 璇锋眰浣撲笂闄?| 8 KiB |
| `/say` 闄愭祦 | 10 娆?鍒嗛挓锛堣繘绋嬪唴锛?|

Token 鑾峰彇锛堝湪 Pi 涓婁互 root锛夛細

```bash
sudo grep '^HTTP_TOKEN=' /etc/lofii-bot/env
```

鐢ㄦ埛鍙皢璇ュ€煎啓鍏?AntifieldCloud 鐨勫彈闄?env锛涗笉瑕佹彁浜ゅ埌浠撳簱鎴栧墠绔€?
## 2. GET /healthz

鏃犻渶閴存潈锛屾渶灏忓仴搴蜂俊鎭€傝繘绋嬪瓨娲诲嵆 200銆?
```json
{
  "status": "ok",
  "version": "0.2.0",
  "uptimeSec": 123,
  "state": "connected",
  "connected": true
}
```

`state` 鍙栧€硷細`idle` / `connecting` / `connected` / `backoff` / `cooldown`銆傚姩鎬佹ā寮忎笅 `idle` 鏄甯哥姸鎬侊紙鏃犵帺瀹跺湪绾匡級銆?
## 3. GET /status

闇€瑕?Bearer銆傚瓧娈电ǔ瀹氾紝鍙洿鎺ユ槧灏勫埌闈㈡澘銆?
```json
{
  "version": "0.2.0",
  "uptimeSec": 123,
  "state": "connected",
  "minecraft": {
    "connected": true,
    "username": "lofii",
    "host": "127.0.0.1",
    "port": 25565,
    "version": "26.1",
    "reconnects": 0,
    "lastDisconnect": null
  },
  "player": {
    "dimension": "涓讳笘鐣?,
    "position": { "x": 9.5, "y": 105, "z": -8.5 },
    "health": 20,
    "food": 20
  },
  "server": {
    "reachable": true,
    "online": 1,
    "max": 6,
    "versionName": "Paper 26.1.2",
    "motd": "Raspberry Pi 5 | Minecraft LAN",
    "latencyMs": 5,
    "lastPingAt": "2026-10-22T11:42:37.603Z"
  },
  "presence": {
    "enabled": true,
    "pollMs": 15000,
    "graceMs": 60000,
    "checkMs": 5000,
    "otherPlayers": 0,
    "lastDecision": "connected: alone"
  },
  "ai": {
    "enabled": true,
    "provider": "opencode-go",
    "model": "deepseek-v4.1-flash",
    "inFlight": 0,
    "queued": 0,
    "failures": 0,
    "lastLatencyMs": 2359,
    "lastError": null
  },
  "memory": { "players": 1, "turns": 2 },
  "task": {
    "enabled": true,
    "active": false,
    "name": null,
    "state": "idle",
    "startedAt": null,
    "elapsedSec": 0,
    "progress": {
      "fishCaught": 0,
      "wheatHarvested": 0,
      "planted": 0,
      "deposited": 0
    },
    "failures": 0,
    "lastError": null
  }
}
```

璇存槑锛?
- `minecraft.connected` 鏄?Bot 鑷韩鏄惁宸?spawn锛沗server.online` 鏄湇鍔″櫒鍦ㄧ嚎浜烘暟锛圔ot 鍦ㄧ嚎鏃跺寘鍚?Bot锛夈€?- `presence.otherPlayers` 涓嶅惈 Lofii銆?- `ai.lastError` 宸叉埅鏂紝涓嶅惈鎻愮ず璇嶆垨瀵嗛挜銆?- `task` 鏄?v0.2.0 鏂板瀛楁锛屽悜鍚庡吋瀹癸紱`state` 鍙栧€?`idle/starting/running/depositing/recovering/stopping`銆俙name` 涓?`fishing`/`farming`/`null`銆?- 璇ユ帴鍙ｄ笉鏆撮湶璁板繂鍐呭銆乀oken銆丱penCode 瀵嗙爜銆?
閿欒锛歚401 {"error":"unauthorized","message":"..."}`銆?
## 4. POST /say

闇€瑕?Bearer + `Content-Type: application/json`銆傝 Lofii 鍦ㄦ父鎴忓叕灞忚涓€娈佃瘽锛?*鍙亰澶╋紝涓嶆墽琛屼换浣曟寚浠?*銆?
璇锋眰锛?
```json
{ "message": "鏉ヨ嚜 AntifieldCloud 鐨勯棶鍊? }
```

鎴愬姛锛圔ot 鍦ㄧ嚎锛夛細

```json
{ "ok": true, "lines": 1 }
```

琛屼负涓庨敊璇爜锛?
| 鏉′欢 | HTTP | 鍝嶅簲 |
|---|---|---|
| 姝ｅ父鍙戦€?| 200 | `{"ok":true,"lines":N}` |
| 鏈甫/閿欒 Token | 401 | `{"error":"unauthorized",...}` |
| 鏈湪绾匡紙鍔ㄦ€佹ā寮忎笅绌烘湇锛?| 409 | `{"error":"not_connected",...}` |
| 棣栧瓧绗︿负 `/` | 400 | `{"error":"message_must_not_start_with_slash",...}` |
| 绌烘秷鎭?瓒?720 瀛楃/JSON 閿欒 | 400 | `{"error":"invalid_request",...}` |
| 闈?JSON Content-Type | 415 | `{"error":"unsupported_media_type",...}` |
| 瓒呰繃 10 娆?鍒嗛挓 | 429 | `{"error":"rate_limited",...}` |
| 璇锋眰浣?> 8 KiB | 413 | `{"error":"payload_too_large",...}` |
| 鍏朵粬鏂规硶 | 405 | `{"error":"method_not_allowed",...}` |

```bash
TOKEN="$(sudo grep '^HTTP_TOKEN=' /etc/lofii-bot/env | cut -d= -f2-)"
curl -fsS http://127.0.0.1:3010/status -H "Authorization: Bearer $TOKEN"
curl -fsS -X POST http://127.0.0.1:3010/say \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"鏉ヨ嚜闈㈡澘鐨勯棶鍊?}'
```

## 5. 娓告垙鍐呰涓猴紙渚涢潰鏉垮睍绀哄弬鑰冿級

- 鍞ら啋璇嶏細`Lofii` / `@Lofii`锛堜笉鍖哄垎澶у皬鍐欙紱鍙湪琚偣鍚嶆椂鍥炲锛夈€?- 鎸囦护锛堜粎 `COMMAND_ALLOWLIST` 鍐呯帺瀹讹紝榛樿 `Antifield`锛夛細
  - `Lofii 鐘舵€乣 / `status`锛堝惈浠诲姟杩涘害锛?  - `Lofii 鍘婚挀楸糮 / `閽撻奔` / `fish`
  - `Lofii 鍘荤鐢癭 / `绉嶇敯` / `鏀惰彍` / `farm`
  - `Lofii 鏀跺伐` / `鍋滄浠诲姟` / `stop task`
  - `Lofii 鍥炲` / `home`
  - `Lofii 瀛樹笢瑗縛 / `瀛樼` / `deposit`
  - `Lofii 杩囨潵` / `come`
  - `Lofii 璺熼殢鎴慲 / `follow [鐜╁]`
  - `Lofii 鍋滀笅` / `stop`锛堜粎鍋滄绉诲姩锛屼笉鍋滄浠诲姟锛?  - `Lofii 鐪嬫垜` / `look`
  - `Lofii 鎸ユ墜` / `wave`
  - `Lofii 甯姪` / `help`
- 闈炴巿鏉冪帺瀹跺彂鎸囦护锛氬浐瀹氭嫆缁濓紝涓嶇Щ鍔ㄣ€佷笉鍚姩浠诲姟銆?- AI 鍥炲鍏睆鍙戦€侊紝鑷姩鎷嗚锛堟瘡琛?鈮?40 瀛楃銆佹渶澶?3 琛岋級锛岄瀛楃 `/` 浼氳杞箟銆?- 浠诲姟鏈熼棿鍗充娇 Antifield 涓嬬嚎锛孡ofii 淇濇寔鍦ㄧ嚎锛涗换鍔＄粨鏉熷悗鎭㈠鍔ㄦ€佷笅绾裤€?- AI 鎰忓浘鍏滃簳鍙 Antifield 鐨勪换鍔＄被妯＄硦璇彞鐢熸晥锛涙ā鍨嬭緭鍑虹粡杩囨灇涓?缃俊搴︽牎楠岋紝涓嶈兘鎼哄甫鍧愭爣鎴栦换鎰忓懡浠ゃ€?
## 6. 瀵规帴寤鸿

- 闈㈡澘杞 `/status`锛堜緥濡?10鈥?0 绉掞級鍗冲彲灞曠ず鍦ㄧ嚎鐘舵€?鐜╁/浣嶇疆/浠诲姟杩涘害锛涗笉瑕侀珮棰戣疆璇€?- `/say` 浠呯敤浜庝富鍔ㄦ挱鎶ワ紱涓嶈鎶婂畠褰撳懡浠ら€氶亾銆?- `409 not_connected` 鏄姩鎬佹ā寮忕殑姝ｅ父鐘舵€侊細绛夌帺瀹朵笂绾垮悗 Lofii 浼氳嚜鍔ㄥ姞鍏ャ€?- v0.2.0 浠嶄笉鎻愪緵 HTTP 浠诲姟鍚姩/鍋滄鎺ュ彛锛涗换鍔＄敱娓告垙鍐呭浐瀹氱煭璇垨 Antifield 鐨?AI 鎰忓浘瑙﹀彂銆傝嫢闇€瑕侀潰鏉挎帶鍒讹紝鍚庣画澧炲姞 `POST /task/start|stop` 涓?SSE锛堣 `docs/ROADMAP.md`锛夈€?- 浠讳綍 AntifieldCloud 渚ф敼鍔ㄣ€乀oken 娉ㄥ叆銆侀潰鏉?UI 鍧囩敱鐢ㄦ埛鑷瀹炴柦锛涙湰浠撳簱涓嶅寘鍚繖浜涙敼鍔ㄣ€?

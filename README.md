# WorkBuddy 账号中枢（pi 全局扩展）

多账号 WorkBuddy（CodeBuddy）管理：**批量签到** + **切换账号** + **限流自动换号**。

纯本地运行，无遥测。账号名默认脱敏，截图/日志不会泄露昵称。

```
◉ 主账号                 国内版  剩 29.3 天    4035.57   今日 已签 +100
  备用号 A               国内版  剩 30.0 天    3614.74   今日 已签 +100
  备用号 B               国内版  剩 27.8 天    3561.54   今日 已签 +100
  国际号                 国际版  剩 360.8 天   0         今日 无活动

  积分合计：11211.85
```

## 安装

一个包就够了，**不需要**再装 provider：

```bash
pi install npm:pi-workbuddy-hub

# 或从 GitHub
pi install git:github.com/lucaslz2020/pi-workbuddy-hub

# 或本地目录
pi install ~/.pi/agent/extensions/workbuddy-hub
```

装完 `/reload` 或重开 pi，敲 `/wb` 看到账号列表就成功；`/model` 里应该已经有
`workbuddy/*` 和 `workbuddy-global/*` 两套模型。

也可以直接丢进 `~/.pi/agent/extensions/workbuddy-hub/`，pi 启动时自动发现，无需 `pi install`。

> **内置 provider**：本包已集成 `pi-provider-workbuddy`（MIT © lorlike）的全部代码，
> 同时注册 `workbuddy`（国内）与 `workbuddy-global`（国际）两个 provider。
> provider 自带的 `workbuddy.*` 命令**已被拦下不注册**，相关能力合并到 `/wb`：
> `/wb refresh`（刷新模型目录）、`/wb logout`（清除凭据）。
> 归属说明见 `src/provider/NOTICE.md`。
> 如果你之前装过独立的 `pi-provider-workbuddy`，**必须**卸掉，否则同名命令会重复注册：
>
> ```bash
> pi uninstall npm:pi-provider-workbuddy
> ```
> 同理，**不要**同时以本地目录和 npm 两种方式装本包——两份同名扩展会让 pi 整份跳过，
> 表现为「`/wb` 不存在」。

## 隐私

默认就防截图/日志泄露：

| 场景 | 默认行为 |
|---|---|
| TUI 里自己看 | 真名（`Alice199`） |
| **管道 / 重定向 / CI 日志** | 自动脱敏（`Al****99`） |
| 邮箱形式的昵称 | 一律显示成 `#1a2b3c4d`（前缀常含真名） |
| 错误消息里的昵称/uin/uid | 自动替换 |

手动切换：

```text
/wb mask full      # 真名（自己看）
/wb mask mask      # Al****99
/wb mask hash      # #1a2b3c4d
```

永久设置（`~/.pi/agent/settings.json`）：

```json
{ "workbuddy": { "mask": "hash" } }
```

或环境变量 `WORKBUDDY_MASK=hash`。CLI 加 `--no-mask` 可强制真名。

优先级：环境变量 > settings.json > 默认（TTY 用 full，非 TTY 用 mask）。

## 它解决什么

WorkBuddy 的 provider 凭据是**单槽位**的：一个账号登录就覆盖上一个。于是：

- 多账号要一个个手动切
- 某个号被限流/积分用尽，只能眼睁睁看着失败

这个扩展补这两块。provider 代码内置在 `src/provider/`（原 `pi-provider-workbuddy`，
MIT © lorlike），逐字保留、便于跟进上游；本包自己的代码只负责账号策略层。

## 自动换号（核心）

一个号不可用了就自动换下一个，**下一次请求就用新账号发出**。

### 触发规则

| 症状 | 归类 | 动作 |
|---|---|---|
| `429` / `code=37` / 「请求过于频繁」 | rate-limited | 换号，冷却 **10 分钟** |
| `14018` / 「积分不足」 | quota | 换号，冷却到**明天 00:00** |
| `12153` / `401` / 「会话已失效」 | revoked | 先静默续期自救，救不回才换号**永久跳过**（需重登）；续期接口无应答则按限流冷却 10 分钟观察 |
| `14003` / 「模型负载高」 | upstream-busy | **不换号**，退避重试 |
| HTTP `5xx` | transient | **不换号**，退避重试 |
| `ECONNRESET` / `fetch failed` | transient | **不换号**，退避重试 |
| 认不出的错误 | — | **不换号**，原样上报 |

**最后三行是重点**：模型负载高、5xx、网络抖动都**不是账号问题**。把它们也当限流去换号，会把所有号的冷却时间白白烧掉，最后「全都限流」其实一个都没限流过。

### 同一号连续失败 3 次

升级成「压到明天」——说明这个号是真废了，不是偶发。成功一次就清零。

### 怎么接进 pi 的三个时机

pi 没有「请求失败换凭据重试」的公开接口，所以分三层挂：

| 时机 | Hook | 干什么 |
|---|---|---|
| 请求前 | `before_agent_start` | 当前号在冷却 → 先换到可用的，让这次请求不白跑 |
| 响应后 | `after_provider_response` | 429/401/5xx → 立刻判定并记故障 |
| 消息结束 | `message_end` | 从 `stopReason=error` 的 `errorMessage` 里认限流/额度/失效 |

### 切换为什么需要四步

```
① 写 vault（~/.pi/agent/workbuddy/workbuddy-vault/<region>/<id>.json）
② 写 provider 刷新副本（workbuddy/auth.<region>.json）
③ 写 auth.json（provider 槽位）
④ 丢 provider 的进程内凭据缓存
```

**①②不能省**：provider 的 `pickBest()` 让刷新副本与 vault 都排在 auth.json 之前，只改 auth.json 会被静默覆盖。
**④不能省**：`WorkBuddyCredentialStore` 在进程内缓存解析结果，不丢的话它继续用旧 token —— 表现就是「切换成功但账号没变」，而且新号一直失败（请求其实是旧号发的）。

丢缓存走 provider 模块自己的 `invalidateCredentialCache()`，**不再**绕 `ctx.modelRegistry.getRegisteredNativeProvider()`：本包用 legacy 的 `pi.registerProvider(id, config)` 注册，条目落在 registry 的 `extensionProviders` 里，而 `getRegisteredNativeProvider()` 读的是 `nativeExtensionProviders` —— 对这类注册永远返回 `undefined`，于是那条路一直在静默空转（0.1.4 修掉）。

另外缓存会**自己校对**：`resolve()` 每次先比对磁盘上的 uid 指纹（刷新副本 + auth.json 槽位），变了就重解析。所以另一个 pi 窗口里切号、或手改了 auth.json，本进程下一次请求也会跟上。比较的是 uid 而不是 token，正常续期不会触发重读。

**实测**：切换后 `pi -p --model workbuddy/glm-5.3` 立即用新号返回。

## 命令

| 命令 | 说明 |
|---|---|
| `/wb` | 总览：账号、区域、token 剩余、**当前可用积分与合计**、今日签到、冷却状态（`◉`=当前使用） |
| `/wb sign [id\|昵称]` | 批量签到。**幂等**，一天跑几次都只有第一次真领 |
| `/wb use [id\|昵称]` | 切换到指定账号（同区域会覆盖，有确认与备份） |
| `/wb failover` | 故障总览 + 触发规则 |
| `/wb failover on\|off` | 开关自动换号（默认开） |
| `/wb failover reset` | 清空所有冷却 |
| `/wb sync` | 重新扫描三个来源 |
| `/wb add` | 添加账号（桌面端导入 / 粘凭据 JSON / 粘裸 token） |
| `/wb rm <id\|昵称>` | 删除账号簿里的账号（vault 与桌面端不动） |
| `/wb doctor` | 诊断：来源文件、token 到期、**积分余额**、refreshToken、at-rest 密钥、故障状态 |
| `/wb auto [on\|off\|HH:MM]` | session 内每天自动签到（默认 09:05） |

## 账号从哪来

三个来源，按 `sha256(uin||uid)` 去重：

| 来源 | 路径 | 说明 |
|---|---|---|
| vault | `~/.pi/agent/workbuddy/workbuddy-vault/<region>/*.json` | `/login workbuddy` 扫码进来的，与 provider 共用 |
| 账号簿 | `~/.pi/agent/workbuddy/multi/*.json` | 桌面端导入、手贴 token、刷新后的新 token |
| 桌面端 | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | **只读镜像**，永不回写 |

### 桌面端为什么要先取密钥

macOS 的 WorkBuddy 5.3.8+ 把 `accessToken` / `refreshToken` / `nickname` 加密成
`{"$wbEncrypted":1,"envelope":"…"}`，密钥只在客户端进程内。取一次：

```bash
node bin/extract-at-rest-key.mjs
```

会短暂起一个带 inspector 的第二实例，调原生模块拿 `atRestSecretKey`，不碰正在运行的客户端、不改任何文件。取到的密钥在 `~/.workbuddy-account-hub/at-rest-key`，并会与 `~/.workbuddy/keyblob` 的 `protectorKeyId` 校验。

**解密的关键是 AAD**（比密钥更容易踩）：

```
"WB-AAD\0" + 0x01
  + len32("WBEV1") + "WBEV1"      ← 字段帧（整文件是 WBEF1）
  + len32("sym-v1") + "sym-v1"
  + u32be(1)                       ← suite
  + len32(keyId) + keyId           ← 必须带
  + 0x02 + 0x00 + 0x00
```

密钥派生对了、nonce/tag 都对，缺 AAD 一样 `bad decrypt`。密文还可能带 6 字节 `WBE` 帧前缀要剥掉。

## 加账号

**1. 桌面端（零操作）** — 装了并登录桌面端，`/wb` 自动带出来。

**2. 扫码（推荐给新号）**

```
/login workbuddy          # 国内版
/login workbuddy-global   # 国际版
```

provider 按账号分文件写 vault，多号扫码不互相覆盖。

**3. 手贴 token** — `/wb add`，交互式选。

## 签到（无人值守）

`/wb auto` 只在 session 内有效。每日自动跑用系统定时器：

```bash
./bin/install-launchd.sh          # 每天 09:05
./bin/install-launchd.sh 08:30
```

日志 `~/Library/Logs/WorkBuddy/checkin.log`。

Linux/cron：

```cron
5 9 * * * /usr/bin/node ~/.pi/agent/extensions/workbuddy-hub/bin/checkin.mjs --json >> ~/wb-checkin.log 2>&1
```

CLI 与扩展共用同一份 `runner`：

```bash
node bin/checkin.mjs              # 全部签到
node bin/checkin.mjs --dry-run    # 只查状态 + 余额，不发领奖请求
node bin/checkin.mjs --json       # 机器可读（含 credits 合计）
node bin/checkin.mjs --only 主账号
```

退出码：`0` = 全部有结论；`1` = 有失败或需重登。

## 积分怎么算

两个**不同口径**的数，界面上分开写，绝不加在一起：

| 名字 | 来源 | 含义 |
|---|---|---|
| **积分**（表里的那一列） | `/v2/billing/meter/get-user-resource`（企业成员走 `/billing/meter/get-enterprise-user-usage`） | 钱包里**还能花多少**（未过期资源包剩余求和） |
| **合计**（表尾那行） | 上面各账号求和 | 所有账号加起来的可用积分 |
| 签到活动累计 | `/v2/billing/meter/checkin-activity-status` 的 `total_credits` | 这次签到活动**累计发了多少**（`/wb sign` 的「合计 +100」是这个口径） |

`/wb status`、`/wb doctor`、`wb-checkin` 都会现查余额（只读、不发领奖请求）。

读不到时显示 **`未知`**，并且合计行会写清楚算了几个账号（`（3/4 个账号读到余额）`），
下面再跟一行原因（`余额没读到：上游限流（http 429）`）—— 读不到不等于 0 分。
网关抽动/限流/非 JSON 会先重试一次再报，所以偶发的「未知」不会反复出现。
余额查询失败**不影响**签到结论与退出码。

> 余额查询是**在 `/wb status` 执行时现查**的。写完代码后必须 `/reload`（或重开 pi）
> 才会用上新代码 —— 扩展模块在进程内缓存，不重载就还是旧实现。

## 签到行为

- **幂等**：先查活动状态（只读）→ 活动没开或今日已签就**不发领奖请求**
- **按北京时间**（固定 +8，不依赖系统时区库）
- **业务码是答案**：`1001` 已签 = 成功；`1002` 不可参与；`1003` 活动已结束
- **401 单独归类**：是「需重登」不是「失败」；先试 refreshToken 静默续期
- **国际版没有签到活动**：`workbuddy.ai` 出厂关闭，照实报「无活动」

## 代码结构

重构后的分工：**每个概念只有一份实现**，模块之间单向依赖（`index.ts` 只接线）。

| 文件 | 只负责 | 以前重复在 |
|---|---|---|
| `src/upstream.ts` | 域名/路径/UA/业务码 —— 唯一一份事实表 | 账号层 + `provider/upstream.ts` 各一份 |
| `src/fields.ts` | 上游字段的 snake/camel 双拼写读取 | `checkin.ts` / `provider/checkin.ts` / `store.ts` / `oauth.ts` 各一份 |
| `src/jsonfile.ts` | 状态文件原子读写 + 备份 | `accounts.ts` / `switch.ts` / `failover.ts` / `provider/auth.ts` 各一份 |
| `src/time.ts` | 北京日、明天 00:00、剩余天数 | `accounts.ts` / `failover.ts` / `runner.ts` 各一份 |
| `src/at-rest.ts` | 桌面端加密字段 + 两条密钥来源 | 账号层与 `provider/at-rest.ts` 各一份实现 |
| `src/accounts.ts` | 账号池：三条来源、解析/序列化、签到记录 | 与 `provider/auth.ts` 重复 |
| `src/checkin.ts` | 签到协议 + token 续期（**唯一一份**） | `provider/checkin.ts` 是第二份 → 已删除 |
| `src/runner.ts` | 一个账号怎么跑、批量并发、兜底重试、只查不领 | CLI 自己写了一份 dry-run |
| `src/switch.ts` | 切号三步（写 vault / 写 auth.json / 丢缓存） | — |
| `src/failover.ts` | 错误 → 故障判定 + 冷却状态 | — |
| `src/view.ts` / `src/mask.ts` | 排版 / 脱敏（含列宽与截断） | `index.ts` 与 `bin/checkin.mjs` 各一份 `pad` 与图例 |
| `src/commands.ts` | `/wb` 的每个子命令 | 曾有 780 行的 `index.ts` |
| `src/index.ts` | **只做接线**：注册 provider、挂 4 个 hook、注册 `/wb` | — |

`src/provider/` 保留的是协议层（provider 注册、模型目录、流式转发、DSML 恢复）。
它不再自带账号/签到/解密的副本，也不再注册任何斜杠命令。

## 职责划分

| | 内置 provider（`src/provider/`） | 本包自有代码 |
|---|---|---|
| 模型接入 | ✅ | — |
| 单账号签到 | — | ✅（唯一实现：`src/checkin.ts`） |
| 多账号池 | — | ✅ |
| 切换账号 | 只能重新 `/login` 覆盖 | ✅ `/wb use` |
| 限流自动换号 | — | ✅ |
| 刷新模型目录 | ✅ | ✅ `/wb refresh`（转发） |
| 清除凭据 | ✅ | ✅ `/wb logout`（转发） |

**只有一个命令入口：`/wb`。**

## 已知边界

- **同区域只能挂一个号**：pi 的 provider 凭据是单槽位。想 4 个号同时出现在模型选择器里，需要 provider 插件支持多 profile（注册 `workbuddy:account-a` 之类独立 id），不在本扩展范围。
- **自动换号后的重试时机**：pi 自身对错误消息有自动重试（`retry.maxRetries` 默认 3），换号后通常下一次重试就用新号。但 pi 对 401/额度类错误可能不重试，此时需要你手动再发一次（换号已经生效了）。
- **改 auth.json 前会备份**成 `auth.json.bak-<时间戳>`。

## 开发

```bash
npm test        # 类型检查 + bin 语法检查 + 单元测试（CI 与 prepublishOnly 都跑这个）
npm run unittest # 只跑 test/*.test.mjs
npm run tidy    # 发布前隐私自检（本地手动跑）
```

> `bin/tidy.mjs` 只存本地、不进仓库：它的 DENY 清单里写着作者本人的标识原文，
> 提交或发包都会把这些标识公开。发布前记得在本地跑一遍，红了就先清再打 tag。

类型检查（需要 pi 的两个 peer 依赖，本地没装的话临时链一下）：

```bash
npx -p typescript@5 tsc -p tsconfig.check.json --noEmit
```

## 安全

- 凭据只在本机流转，无遥测，不经第三方服务器
- 桌面端凭据只读
- 日志与诊断只打来源路径和到期天数，不打 token
- `failover.json` 只存状态/原因/计数，不存凭据

## License

MIT

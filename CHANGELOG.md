# Changelog

## [0.1.3] — 2026-11-12

### 新增

- **`/wb status` 显示积分与总积分**：新增「积分」列（账号当前可用余额），表尾一行「积分合计」。
  CLI 的 `wb-checkin` 同样显示单账号余额与合计，`--json` 多出 `credits: {total, accounts, known}` 与
  每个账号的 `balance`。余额与签到活动累计（`total_credits`）是两个口径，分开报，绝不加在一起。
  - 余额读 `/v2/billing/meter/get-user-resource`（企业成员走 `/billing/meter/get-enterprise-user-usage`），
    与 `provider/client.ts` 的 `fetchCredits()` 同一条路径，但只读且**日志不落 token**。
  - 读不到时显示 **`未知`**，合计行注明「（3/4 个账号读到余额）」—— 读不到不等于 0 分；
    余额查询失败不影响签到结论与退出码。
  - **没读到会告诉你为什么**：网关抽动/限流/非 JSON 重试一次再下结论，
    仍失败就在合计行下多一行「余额没读到：上游限流（http 429）」之类的原因。
    以前这一步静默返回 `undefined`，界面只剩下一个「未知」，看起来像功能没生效。
  - 余额查询限 **3 并发**（与批量签到一致）：上游对同 IP 并发敏感，
    十几个请求一口气发出去，回来的可能就是几个 429 和几个「未知」。

### 修复

- **昵称不再停在扫码那一刻**：`Alice199` → `Alice1999` 这类在客户端改名后，vault 里存的仍是旧昵称，
  列表里看着就像「这个号没加进来」。现在同一个号（区域 + uid 相同）合并时，**昵称取桌面端
  live 文件那条**（登录时现写、最新），id / token / 来源仍跟着原来的规则走，签到记录 key 不变。

## [0.1.2] — 2026-11-12

### 修复

- **同一个号不再出现两条**：账号 id 的口径是 `sha256(uin||uid)`，所以同一个号先是「只有 uid」、
  后来变成「带 uin」的登录态时，会算成两个 id —— `/wb status` 里两行一样的昵称和说明，
  `/wb sign` 的「需要处理」也跟着重复。现在按 `id` 去重之后再按「区域 + uid」合并，
  留 token 最新、来源更可信的那条（`book` > `vault` > `desktop`），id 跟着它走，
  切号与写回不会落回旧文件。

## [0.1.1] — 2026-11-11

### 新增

- **包名进 keywords**：npm / 市场搜索结果里按 `pi-workbuddy-hub` 名称可直接命中。

## [0.1.0] — 2026-11-10

### 命令入口合并为 /wb

- **provider 不再注册任何斜杠命令**：内置 provider 原本会注册
  `/workbuddy.status|sign|refresh|logout`，和多账号的 `/wb` 并列，容易分不清哪个
  管全部账号、哪个只管当前槽位。
  - `status` / `sign` 直接删除，由 `/wb status`、`/wb sign` 取代（多账号版）
  - `refresh` / `logout` 改成 `register.ts` 的导出函数，由 `/wb refresh`、
    `/wb logout` 调用（逻辑要用 provider 私有状态，不重复实现）
  - 现在 provider 只负责：注册 provider、拉模型目录、流式转发
  - **唯一命令入口是 `/wb`**

如果之前用过 `/workbuddy.status` 等命令，改用：

| 旧 | 新 |
|---|---|
| `/workbuddy.status` | `/wb status` |
| `/workbuddy.sign` | `/wb sign` |
| `/workbuddy.refresh` | `/wb refresh` |
| `/workbuddy.logout` | `/wb logout` |


### 内置 provider，单包安装

- **内置 provider，单包安装**：集成 `pi-provider-workbuddy` 0.2.0 全部代码到 `src/provider/`
  （MIT © 2026 lorlike，逐字保留，见 `src/provider/NOTICE.md`）。现在只装本包即可获得
  `workbuddy` / `workbuddy-global` 两套模型，不再需要单独安装 provider 包。
- 新增 peerDependency `@earendil-works/pi-ai`（provider 需要 `compat.registerApiProvider`）。

### 多账号中枢

- **多账号池**：聚合 vault（扫码登录）、账号簿（桌面端/手贴 token）、桌面端只读镜像三个来源，按 `sha256(uin||uid)` 去重
- **批量签到**：幂等、按北京时间划天、业务码分类（1001 已签 = 成功而非失败）
- **切换账号**：`/wb use`，写 vault + 刷新副本 + auth.json 并失效 provider 缓存
- **自动故障转移**：限流/额度用尽/会话失效自动换号；模型负载、5xx、网络错误**不换号**（换号解决不了，只会白烧所有号的冷却）
- **账号名脱敏**：非 TTY（管道/日志/CI）默认自动 mask，邮箱形式昵称降级为 hash
- **桌面端 at-rest 解密**：支持 macOS 的 `$wbEncrypted` 字段（AES-256-GCM + 自定义 AAD）
- **发布前隐私自检**：`bin/tidy.mjs` 只存本地（清单含作者标识原文，不进仓库不发包），发布前手动跑一遍

### 说明

- 同一区域只能挂一个账号（pi 的 provider 凭据是单槽位）；跨区域可并存
- 国际版（workbuddy.ai / codebuddy.ai）出厂没有签到活动，会如实报「无活动」

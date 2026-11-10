# Changelog

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

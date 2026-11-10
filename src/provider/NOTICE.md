# 第三方代码归属

本目录（`src/provider/`）的代码来自 **pi-provider-workbuddy**：

- 原始仓库：https://github.com/lorlike/pi-provider-workbuddy
- 作者：lorlike
- 许可：MIT（与根目录 LICENSE 同文，上游版权归 lorlike 所有）
- 移植时版本：0.2.0

## 相对上游的改动

协议层的行为（端点、header、DSML 恢复、错误分类）逐字保留；偏离都在「这本来属于
账号层」的地方，全部记在这里便于跟进上游：

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/index.ts` → `register.ts` | 重命名 | 避免与顶层 `src/index.ts` 混淆 |
| `register.ts` 末尾 | 删掉 `status` / `sign` / `refresh` / `logout` 四个 `pi.registerCommand`；后两个改写成导出函数 `refreshModelCatalog()` / `clearLocalCredentials()` | 见下 |
| `upstream.ts` | 改成对 `src/upstream.ts` 的转发，只留 provider 独有的 UA/超时/错误体上限 | 上游这份表与账号层的几乎逐字重复；两份漂移会让聊天基址和签到基址不一致 |
| `auth.ts` | 只保留「桌面端候选路径 + 每区域刷新副本」；解析/序列化/身份派生改用 `src/accounts.ts` | 同一个文档格式曾有两份解析器与两份序列化器 |
| `at-rest.ts` | **删除**，改用 `src/at-rest.ts` | 加密算法完全同一套，只有密钥来源不同（一个问 App 要、一个读环境变量/文件）；合并后两条来源都试 |
| `checkin.ts` | **删除**，改用 `src/checkin.ts` | 它是同一套签到协议的第二份实现，且已无人调用 |
| `wire.ts` / `wire-headers.ts` | **删除**，header 组装回到 `client.ts` 的 `chatHeaders()` | 两个文件互相转发同一批函数，只为了拆一个并不存在的循环依赖 |
| `store.ts` | 凭据解析改用 `src/checkin.ts` 的 `refreshCredential()`；模型目录解析留在本地 | 续期只有一份实现 |

### 为什么删掉那四个命令

它们属于**账号层**，不属于**协议层**。本包已经有 `/wb`，原样保留会出现
「`/workbuddy.status` 和 `/wb status` 并列」——用户分不清哪个管全部账号、哪个只管
当前槽位。

处理方式：

- `status` / `sign` → 彻底删除，由 `/wb status`、`/wb sign` 取代（多账号版，功能更全）
- `refresh` / `logout` → 逻辑要用本模块私有的 `stores` / `catalogs`，所以留下，
  但改成普通导出函数，由 `/wb refresh`、`/wb logout` 调用

现在 provider 只负责：注册 provider、拉模型目录、流式转发。**斜杠命令只有 `/wb` 一个入口。**

### 跟进上游时怎么做

```bash
# 1. 用上游新版本覆盖本目录
cp -R <新版本>/src/* src/provider/

# 2. 重跑上面的改动：
#    · mv index.ts register.ts
#    · 删掉末尾四个 registerCommand，把 refresh/logout 改成导出函数
#    · upstream/auth/at-rest/checkin 改回对 ../ 的转发与复用（见上表）
#    · 删掉 wire.ts / wire-headers.ts

# 3. 验证命令入口仍然只有一个
pi -p "list slash commands starting with wb or workbuddy"   # 应只有 /wb
```

本目录的 npm 包 `pi-provider-workbuddy` 依赖已由宿主包
`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` 提供，声明在本包
`peerDependencies` 中。

## 为什么内置

上游包只负责注册 provider（`workbuddy` / `workbuddy-global` 两个 id），
而本包的多账号切换依赖这两个 id 存在才能操作 auth.json 槽位。内置后只需安装
本包一个扩展即可获得完整能力。

上游更新时直接覆盖本目录即可；唯一的集成点是
`src/index.ts` 里对 `registerWorkBuddyProviders(pi)` 的 `await` 调用。

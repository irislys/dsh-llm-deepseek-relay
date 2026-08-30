# dsh-llm-deepseek-relay

把官方 DeepSeek 模型经**中转站/网关**接入 dsh 的插件：复用一个 `DeepSeekAdapter` 实例按供应商注册新路由，让 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`(dsv4fve) 走你自己的中转站，**模型参数与官方 `deepseek-official` 完全一致**（请求只差 `baseURL`、模型 id=`relayId`、key 三项，其余形态一致），且配置文件只管「中转 + 新增功能」。

> 为什么不用「照抄参数到自定义供应商」：dsv4fve 的 `reasoning_effort` / `reasoning_content` / `thinking` / 图片 pixel·byte 预算 / Files API 这些参数**绑定在官方 DeepSeek 适配器上**，`llm-pi-ai` 这类自定义供应商的 compat 门控给不了、也不能照抄。所以让同一条适配器改 `baseURL` 指向中转站，参数自然与官方一致。

---

## 适配声明

> 在 DeepSeek 官方开放**通用的第三方 API / 适配标准**之前，本项目**只同步 DeepSeek Harness 的最新发布版本**来写代码：每次 dsh 发版，本插件立即跟进其最新 API 约定（适配器构造约定、钩子、请求扩展字段等），只保证与**最新版本**的兼容性。
>
> **不再承诺向下的兼容适配。** dsh 发版中的破坏性改动（例如 `0.1.2-alpha` 起官方适配器新增的 `prepareExtensions` 调用约定）会让插件在**旧版 dsh** 上直接无法工作；本项目不维护旧版本兼容分支，也不会为旧版本做特判适配。需要在指定 dsh 版本下使用，请自行回退到对应历史 commit，按其 `package.json` 的依赖版本重打 tarball（自担风险、不做保证）。
>
> 官方一旦发布通用的第三方 API 标准，本声明自动终止，届时按稳定标准重新评估兼容策略。

## 前提

- dsh（`@deepseek-ai/dsh`）已安装并跑过 `dsh --profile web`。
- 中转站是 **DeepSeek/OpenAI 兼容**（能被 `thinking` / `reasoning_effort` / `reasoning_content` / `stream_options.include_usage` 透传）。图片默认走 DeepSeek **Files API**（`POST /files`），否则回退 base64 内联。

## 安装

> 插件目前**尚未发布到 npm**，用下面任一方式安装进 profile（二选一）。

### 方式 A：GitHub git 源（推荐）
```sh
dsh plugin --profile web add "github:irislys/dsh-deepseek-relay-config#main"
```
仓库根目录就是插件包（`package.json` 带 `dsh.bundle`），会直接拉取并装进 profile。

> `#main` 是**滚动分支**：装到的就是当时的 HEAD（跟随 dsh 最新发布验证，见上方适配声明）。要冻结某个历史版本，改用对应 commit 引用或用方式 B 的本地 tarball。

### 方式 B：本地 tarball（已验证）
```sh
git clone https://github.com/irislys/dsh-deepseek-relay-config
cd dsh-deepseek-relay-config
pnpm pack
dsh plugin --profile web add ./dsh-llm-deepseek-relay-<ver>.tgz
```

装完会把它加入 `dsh.profile.bundles`，并把所依赖的 `@deepseek-ai/dsh-llm-deepseek` 等官方包一起装进 profile。

> 兼容性：依赖按 `0.1.2-alpha.2` 固定，需运行 dsh **`0.1.2-alpha.2`**（alpha 小版本间 API 可能已变化，本项目只以最近发布版验证）。若 dsh 版本不同，改 `package.json` 里对应依赖版本后重打 tarball——**这只是有机会兼容的自助手段，项目不保证可用**。
>
> WSL 用户注意：`pnpm pack` 在 Windows 挂载盘（`/mnt/c`、`/mnt/d` 等 DrvFS）上会因 chmod/futime 报 `EPERM`，请在 Linux 原生目录（如 `~/work`）里克隆并打包。

安装后重启 `dsh --profile web`，并在 `$DSH_HOME/deepseek-relay.config.yaml`（见下）填好你的中转站。

## 配置

把 `deepseek-relay.config.yaml` 复制到 `$DSH_HOME/deepseek-relay.config.yaml`（`$DSH_HOME` 默认 `~/.dsh`，Windows 为 `C:\Users\<你>\.dsh`），按需填写。

> 默认从 `$DSH_HOME/deepseek-relay.config.yaml` 读取；如需换路径（多份配置切换、测试等），可在 profile 的插件配置里设置 `configPath` 选项覆盖。

```yaml
relay:
  providers:
    - provider: deepseek-a        # 供应商路由名 / 选择器分组名（别用 deepseek-official）
      baseURL: https://a.example/v1
      apiKey: sk-a-xxxxxxxx      # 硬编码 key（与 apiKeyEnv 二选一）
      # apiKeyEnv: PROVIDER_A_KEY
      models:
        - official: deepseek-v4-flash          # 键值1：必须是官方三选一之一
          relayId: deepseek-v4-flash-0731       # 键值2：真正发给中转站的模型 id（UI 也显示它）
        - official: deepseek-v4-flash-vision-exp
          relayId: dsv4fve
    - provider: deepseek-b
      baseURL: https://b.example/v1
      apiKeyEnv: PROVIDER_B_KEY   # 环境变量名
      models:
        - official: deepseek-v4-pro
          relayId: deepseek-v4-pro-b
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `provider` | 该供应商注册成的路由名（选择器分组名）。不能与 `deepseek-official` 冲突。 |
| `displayName` | 可选的**分组显示名**（Web 选择器里看到的组名）；不填则显示 `provider`。 |
| `baseURL` | 中转站根地址；适配器自动拼 `/chat/completions`。 |
| `apiKey` / `apiKeyEnv` | **二选一**。`apiKey` 直接写 key（硬编码）；`apiKeyEnv` 写环境变量名（经 dsh 凭据服务或启动环境解析）。都填或都不填 → 加载失败。 |
| `models[].official` | **键值1**：必须是 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp` 之一。为空/不存在/不是三选一 → **加载时响亮失败**（指名模型并列出合法 id）。 |
| `models[].relayId` | **键值2**：真正发给中转站的模型 id，自由填写；留空则用 `official`。**Web 选择器显示的也是它**（同一供应商内需唯一）。 |

### 规则（全部在加载时校验，违规即响亮失败）

- **同一个官方模型可以出现在多个供应商下**（每个供应商各指向自己的中转站）；同一供应商内同一官方模型只能出现一次。
- **`relayId` 在同一供应商内必须唯一**（一组内两个模型不能映射到同一个 id）；跨供应商允许相同——Web 选择按 `provider + model` 定位，不冲突。
- **`provider` 名全局唯一**；同名供应商在加载时被拒。
- **`deepseek-official` 是保留名**（官方适配器已占用该路由），用作 `provider` 名会在加载时被拒；与 dsh 其他插件注册的 provider 路由撞名（如 `llm-pi-ai`，无法静态预知）同样表现为加载期响亮失败。
- 每个供应商 `models` 不能为空；总模型数不能为 0。**一个供应商内最多 3 个模型**（官方模型共 3 个且组内不可重复，第 4 个必然报错）；解除「最多 3 个」上限的是**供应商数量/总模型数**（多供应商可远超 3 个）。

### 官方参数为什么不填

`contextWindow` / `maxTokens` / `reasoningEffort` / `thinking` / `imagePixelBudget` / `imageMaxBytes` / 图片 Files-API 预算 / `retryPolicy`……这些**全部由插件内置**官方默认值（`maxTokens 256000`、上下文 `1000000`、不填 `reasoningEffort`=官方默认 high、`thinking: enabled`、`streamIdleTimeoutMs 300000`、vision 模型 `640000` 像素 / 1 MiB），配置文件**不出现**。

## Web 页切换模型

插件把每个供应商注册成一条路由。Web 模型选择器按**供应商分组**（组名 = `displayName`，未设置时为 `provider`），下列该供应商的模型（显示名 = `relayId`）。同一个官方模型挂在多个供应商下时，会在每个分组各出现一次：**切换中转站 = 切换供应商分组**（选中项以 `provider + model` 定位）。切模型就是"选供应商 + 选模型"下拉。要增改模型，改配置文件后**约 2 秒内热重载生效**（`watchFile` 轮询）；**供应商拓扑变化（新增/删除供应商）需重启**。热重载读到的配置若校验失败，**保留上一份好配置并记 error 日志**，运行不中断（区别于启动期的响亮失败）。

## 校验

```sh
dsh --profile web --dump-config | grep -A4 llm-deepseek-relay
```

确认插件行在组合树中；启动 `dsh --profile web` 看是否有加载报错。配置错误会**响亮失败**（给出具体原因）；中转站运行期问题（上游挂、连接失败）**不会**让插件加载失败，只在请求期表现为重试/错误。

仓库自带冲突验证与工具调用清洗器测试（复杂配置撞名/撞 id、真实 llm 注册规则、null/空串流式增量修复），在装有插件依赖的环境里执行：

```sh
npm test
```

## 错误语义小结

- **加载期响亮失败**（结构性配置问题，指名原因）：错的 `official`、组内重复模型、组内重复 `relayId`、同名 `provider`、`apiKey` 与 `apiKeyEnv` **同填**、两者**都没填**、`models` 为空、没有任何供应商。
- **请求期才报错**（加载时不查，运行中按请求失败/重试处理）：`apiKeyEnv` 声明了但凭据服务/启动环境里**解析不到值**（`MISSING_CREDENTIAL`）、`baseURL` 缺失或不可达（`TRANSPORT`）、中转站上游故障/连不上。插件加载时**不探测**中转站。

## 中转站流式兼容（工具调用）

**现象**：部分 OpenAI 兼容网关（newapi 类自定义渠道）流式返回工具调用时，续增量为 `"id": null` / `"name": null`（或空字符串）而不是省略键。官方 `@deepseek-ai/dsh-llm-deepseek` 适配器对这两个字段的守卫是 `!== void 0`（只认 undefined），于是首块携带的真实工具名/id 会被后续空值**覆盖**，表现为工具调用永远失败（`unknown tool ""`）。

**修复**：v0.1.1-rc.6 起，插件内置流式清洗器（`RelayAdapter` → `sanitizeToolCallChunks`）自动修复该模式：按块记住**第一个非空**的 `id`/`name`，只回填被适配器污染（字段存在但为 null/空串）的值。**无需配置**，对所有供应商路由统一生效；「省略键」风格的健康中转站（官方 / ginka 风格）则**字节级透传、零影响**。升级后重启 profile 生效。

**边界**：清洗器只覆盖「块内曾出现正确值、随后被 null/"" 覆盖」这一种签名；若中转站全程不提供正确值，或存在其它兼容问题（参数 400、吞掉 `tools`、图片 `/files` 不支持等），不在其覆盖内。若上游官方适配器修复 `translate()` 的守卫逻辑，本机制会自动退化为无害（可移除）。

## 安全

- 别把 `deepseek-relay.config.yaml` 里的硬编码 `apiKey` 或 `.env` 提交到仓库（`.gitignore` 已忽略 `.env`）。
- 日志不会打印 key。

## 卸载

```sh
dsh plugin --profile web remove dsh-llm-deepseek-relay
```

删除对应的 `provider` 路由及 `$DSH_HOME/deepseek-relay.config.yaml` 即可。

---

### 已知限制

- **线协议固定**为 OpenAI 兼容 `/chat/completions`；`baseURL` 可配，**协议不可换成 Anthropic 或厂商私有格式**（如需自定义协议，需另写 `LlmAdapter`，或用 `llm-pi-ai`）。
- 一个供应商一个适配器实例/一个 `baseURL`；同一模型挂多个供应商 = 多个分组多条路由，**手动切换，无请求级负载均衡/故障转移**。
- 图片输入默认走 DeepSeek `/files`；中转站若不实现 `/files`，失败的图片**逐张回退** base64 内联（不支持时最终整单内联；独立 20 MiB 预算），图片路径与官方可能不完全一致，文字/推理/工具不受影响。

---

## License

[MIT](./LICENSE) © 2026 [irislys](https://github.com/irislys)

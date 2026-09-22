# REQ - dsh llm-pi-ai 传输绕过 fetch 拦截:让"零模型请求"可自查

- Task ID: `2026-09-23_dsh-llm-pi-ai-fetch-bypass`
- Home Repo: `billion-context`
- Created: 2026-09-23
- Status: Done
- Priority: P1
- Owner: xiaofengkuai / ework-agent
- References: https://github.com/ranxianglei/billion-context/issues/1158

## 1. Background & Problem Statement

- **Context**: dsh 原生插件(profile 安装,免启动器)经 `globalThis.fetch` 补丁接管模型流量(`src/agent/native-intercept.ts`)。dsh 的 `llm-pi-ai` 传输层(`@deepseek-ai/dsh-llm-pi-ai` → `@earendil-works/pi-ai` openai-completions)把外部注入的 fetch 直接传给 OpenAI SDK 构造函数(`new OpenAI({ fetch })`),从不经过全局 fetch。
- **Current behavior (symptom)**: 该类 provider 的模型请求完全绕过代理 —— bili.log 零 `processTurn`,`/__bili/stats` 无会话,`acp_status` 工具 404 "no model request has arrived",压缩静默失效;每次工具调用只打一行指向 "stale shim session id after host resume?" 的 warn,无告警、不可自查。
- **Expected behavior**: (issue 期望 #2 退一步方案)请求未被接管时至少打一次性可操作告警,并让工具报错本身携带排查指引。
- **Impact**: 所有经 profile 安装(裸 dsh)且使用 `llm-pi-ai` 自定义 provider 的用户;功能静默失效。

## 2. Reproduction

- **Environment**: Windows 11,dsh web GUI(profile `web`),billion-context 0.1.138,`bili plugin install dsh`,provider 为 settings.yaml `llm-pi-ai.providers.*` 下任意一项。
- **Minimal reproduction steps**:
  1) `bili plugin install dsh`;
  2) dsh 中选 `llm-pi-ai` 管理的 provider 发几条消息;
  3) bili.log 无该会话 `processTurn`;`acp_status` 报 "no model request has arrived with this conversation id yet"。
  对照:同环境换用走普通全局 fetch 的第三方 provider,`processTurn` 立即出现。
- **本地无法完整复现**(需 Windows + dsh web GUI);验证基于代码路径 + issue 提供的 pi-ai 代码证据(openai-completions.js :202/:547/:573-579)+ 本仓 devlog/2026-08-25_dsh-launcher/REQ.md("pi-ai 纯 fetch,无 proxy/CA 接口")。

## 3. Constraints & Non-Goals

- **Constraints**:
  - 不得改变 `/__bili/plugin/tool` 404 错误中 `src/mcp.ts`(ORPHAN_ADOPT)与 `src/agent/opencode-v2.ts` 匹配的既有子串 `no model request has arrived` / `no model request has arrived with this conversation id yet`;
  - 不得触碰 `src/update.ts`、release 流程、acp-kernel pin(#7.4 auto-merge 禁区);
  - 内容分支不动 version。
- **Non-Goals**:
  - 通用拦截任意注入式 fetch(不可行:函数引用私有于宿主模块图,pnpm 隔离阻断跨模块补丁;undici 内部补丁过于侵入)。真正的传输层修复(惰性解析 global fetch / 暴露中间件 seam)属于 dsh 仓库;
  - 不在 takeoverGate 拒绝路径加日志(#1117 的静默是有意设计:第三方进程内插件合法地发起无归属调用);
  - 不改 dsh-native 客户端(插件无法观测到从不经过它的请求,代理侧信号才是唯一精确判定点)。

## 4. Chosen Approach

代理侧检测 + 一次性可操作告警 + 文档:

1. `handlePluginTool` 对"从未注册过"的 conversation(!entry)打**每会话一次性** `[plugin] NO MODEL REQUESTS seen for conversation …` 告警,点明两个成因(SDK 注入 fetch 绕过拦截——已知案例 dsh llm-pi-ai 裸 profile 安装,解法走 `bili dsh` 启动器;或 host resume 后 id 过期)+ 自查方法(发消息看 processTurn);
2. 404 error body 追加同样指引(保留既有子串);
3. README zh/en dsh 节新增已知局限条目;
4. 回归测试 `tests/issue1158-no-model-request-warning.test.ts`(子串保持、一次性语义、entry 分支旧行为不变)。

# Qwen AI CDP Bridge

把**已登录的 Qwen AI 网页版**（chat.qwen.ai）包装成 **OpenAI 标准兼容 API** 的本地服务。

用网页版额度跑对话，任何 OpenAI 兼容客户端（openai SDK、DSH、OpenWebUI、LobeChat 等）把 `base_url` 指向本服务即可直接使用，无需 API Key。

> 与 [deepseek-cdp-bridge](../deepseek-cdp-bridge) 同构：同一套「CDP 控制真实登录页面 + Network 层 SSE 协议级捕获 + DOM 兜底」架构，适配 chat.qwen.ai。

---

## 1. 工作原理

```
客户端(OpenAI格式) → /v1/chat/completions → 串行队列
      → CDP 控制器 → Chrome(9222 调试端口) 中的 chat.qwen.ai 页面
      → 一次性写入文本+发送 → Qwen 流式响应 → Network 层 SSE 协议级捕获完整回复 → 返回
      （SSE 未捕获到时，自动回退 DOM 轮询）
```

- **CDP**（Chrome DevTools Protocol）：连接你已打开的 Chrome，控制真实登录会话
- **SSE 捕获（主路径）**：`Network.dataReceived` 在协议层累积 `chat.qwen.ai/api/v2/chat/completions` 的流式响应，检测到 `delta.status === "finished"` 结束帧后解析出**完整回复**（含代码块）——不依赖页面渲染
- **DOM 兜底**：SSE 拿不到时，回退读取页面 `div.response-message-content`（实测为纯净回答容器，不含思考内容）
- **串行队列**：一次只处理一个会话，杜绝多请求并发串话

> 注意：本质是「模拟真实网页操作」，**违反 Qwen 网页版服务条款**，仅限个人低频自用。正式场景请使用 DashScope 官方 API（`dashscope.aliyuncs.com`）。

---

## 2. 快速开始

### 2.1 启动 Chrome（独立用户目录，与日常浏览器隔离）

```bash
chrome --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-debug
```

然后在该 Chrome 中打开 **https://chat.qwen.ai** 并登录，**保持窗口打开**。

> 调试端口默认只监听 127.0.0.1，局域网/公网无法访问。切勿加 `--remote-debugging-address=0.0.0.0`。
>
> 若同时跑 deepseek 桥：**同一 Chrome 实例可开两个标签页**（chat.deepseek.com + chat.qwen.ai），两个桥共用 9222 端口互不干扰；本服务默认 `API_PORT=3001` 与 deepseek 桥的 3000 不冲突。

### 2.2 启动服务

```bash
cd D:/wkdata/AI/DSH/dsapi/qwen-cdp-bridge
npm install      # 首次
npm start
```

看到日志 `已连接页面: https://chat.qwen.ai/...` 即就绪。

### 2.3 验证

```bash
# Git Bash
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-web","messages":[{"role":"user","content":"你好"}]}'
```

```powershell
# PowerShell（注意 --% 停止解析 + \" 转义）
curl.exe --% -X POST http://localhost:3001/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"qwen-web\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

---

## 3. API 说明

### 3.1 `POST /v1/chat/completions`（标准接口，推荐）

同时支持别名路径 `POST /chat/completions`。

**请求体**（OpenAI 标准格式）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 否 | 模型路由字段（见 3.5）。不填默认 `qwen-web`；支持常见别名（`qwen-max` / `qwen-plus` / `qwen-turbo` / `qwen3` / `qwen2.5-coder` 等），全部路由到内置 `qwen-web`。未知模型也放行（非白名单） |
| `messages` | array | **是** | 对话消息数组，取最后一条 `role: "user"` 的内容发送 |
| `stream` | boolean | 否 | `false`（默认）返回完整 JSON；`true` 返回 SSE 流式增量 |
| `new_session` | boolean | 否 | 显式控制新建会话。**默认不新建**（已取消 session_id 变化自动检测）；`true` 强制新建、`false` 强制不新建。也可用发送 `NEW.TOPIC` 指令消息新建（见 3.3） |
| `session_id` | string | 否 | 自定义会话 ID（可选，默认自动生成） |
| `max_tokens` | number | 否 | 忽略（网页版不受控） |

**非流式响应**：

```json
{
  "id": "chatcmpl-e2e-final-1",
  "object": "chat.completion",
  "created": 1787273173,
  "model": "qwen-web",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "1+1等于2。" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 14 }
}
```

> `usage` 为**估算值**（网页版不返回真实 token 用量），仅供粗略参考。

**流式响应**（`stream: true`，SSE）：

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"1、2、3。"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**错误响应**（OpenAI 标准结构）：

```json
{ "error": { "message": "messages 必须是非空数组", "type": "invalid_request_error", "code": "invalid_messages" } }
```

### 3.2 `POST /chat`（旧版简单接口，向后兼容）

```json
// 请求
{ "message": "你好", "sessionId": "可选", "newSession": true }
// 响应
{ "success": true, "sessionId": "...", "content": "...", "newSession": true, "timestamp": "..." }
```

### 3.3 新建会话（`NEW.TOPIC` 指令 / 显式字段）

**默认不自动新建**（2026-08-21 调整）：已取消"客户端换 `session_id` 即自动新建页面会话"。
网页会话的打开完全由你控制，避免 OpenWebUI / DSH 等客户端切会话时在网页侧堆积空会话、丢失上下文。

**方式一：发送 `NEW.TOPIC` 控制指令（推荐）**

最后一条用户消息内容为 `NEW.TOPIC`（大小写/空格/点号宽松匹配，`new topic`、`NEW TOPIC` 均可）时，
桥接层**新建网页会话**并回显确认 `NEW.TOPIC`（不把指令转发给网页模型）。确认回执后下一条消息即落在新会话里。

```json
// 客户端：单独发一条 NEW.TOPIC 指令
{ "model": "qwen-web", "messages": [{ "role": "user", "content": "NEW.TOPIC" }] }
// 响应（OpenAI 标准格式，content 回显指令）：
{ "choices": [{ "message": { "role": "assistant", "content": "NEW.TOPIC" } }] }

// 然后发真实提问 → 落在新建的网页会话中
{ "model": "qwen-web", "messages": [{ "role": "user", "content": "你好" }] }
```

> 指令独立发送、不与真实提问混在同一回合（混在一起会被当作普通消息处理，不触发新建）。
> 新建在串行队列中 fire-and-forget 执行：确认回执立即返回，下一条消息排在新建之后执行，天然落在新会话。

**方式二：显式字段**：`"new_session": true` 强制新建；`"new_session": false` 强制不新建。

```json
// 强制新建（与 NEW.TOPIC 等效）
{ "messages": [{ "role": "user", "content": "你好" }], "new_session": true }
```

> 注意：换 `session_id` 不再自动新建会话——同一 `session_id` 继续在同一网页会话，换 id 也继续沿用当前网页会话，除非显式新建。
>
> 彻底性：除上述两种显式途径外，桥接层**不会**在任何时机自动新建网页会话（含页面在根路径无会话、发送按钮状态异常等场景，一律保持当前会话页面，仅记录日志或报错提示手动处理）。

### 3.4 CORS（浏览器前端直接调用）

已启用 CORS，允许任意来源的浏览器页面直接 `fetch` 本服务（含 OPTIONS 预检）。

### 3.5 模型路由（内置 `qwen-web`）

**GET `/v1/models`**（及别名 `/models`）返回 OpenAI 标准模型列表。

**支持的模型名称**（客户端 `model` 字段，大小写不敏感）：

| 名称 | 路由目标 | 备注 |
|---|---|---|
| `qwen-web` | 自身（内置） | canonical 模型，默认 |
| `qwen` / `qwen3` / `qwen3-max` / `qwen3-coder` / `qwen3-coder-plus` / `qwen3-flash` | `qwen-web` | Qwen3 系列别名 |
| `qwen-max` / `qwen-plus` / `qwen-turbo` | `qwen-web` | 对话别名 |
| `qwen2.5` / `qwen2.5-max` / `qwen2.5-coder` / `qwen2.5-flash` | `qwen-web` | Qwen2.5 系列别名 |
| `qwen-omni` / `qwen-omni-turbo` / `qwen-vl` | `qwen-web` | 多模态别名 |
| `qwen-reasoning` / `qwen3-reasoning` | `qwen-web` | 深度思考别名，会尽力打开网页思考开关 |
| `qwen/qwen-max` / `qwen/qwen-plus` 等 | `qwen-web` | DashScope 命名空间别名 |

- **未识别的模型**（如 `gpt-4o`）→ 放行并路由到 `qwen-web`（非白名单），提示一次日志。
- **响应回显的 `model`**：原样回显客户端请求的型号名，便于上层按真实模型记录。
- **模型模式联动（尽力而为）**：模型名含 `thinking`/`reasoning`/`思考` → 尝试打开「深度思考」；含 `search`/`联网`/`搜索` → 尝试打开「联网搜索」。Qwen 网页当前 UI 的模式开关为图标按钮（`aria-label="选择模式"`），文本匹配常找不到目标，联动可能静默跳过——**只记日志不阻断发送**。

> 路由规则集中在 `models.js`，新增模型/后端只需改这一个文件。

### 3.6 工具调用（Tool Use / Function Calling）

Qwen **网页版没有对外的原生 function-calling 协议**（不同于官方 `dashscope` API），本桥靠"键入文本 + 读回回复"驱动模型。为支持 OpenAI 的 `tools`/`tool_calls`，本服务用一套**约定格式（DSML，DeepSeek Markup Language，源自 deepseek-web2api-free）**让网页模型"假装"支持工具调用（见 `tooluse.js`）：

1. 请求带 `tools` 时，把**工具清单 + 调用规则**作为前缀注入到用户消息里（`buildToolInstruction`）；
2. 捕获回复，用 DSML 标签 `<|DSML|tool_calls>` → `<|DSML|invoke name="…">` → `<|DSML|parameter name="…"><![CDATA[…]]></|DSML|parameter>` 抽取工具调用；字符串参数值放在 `<![CDATA[…]]>` 中，天然免疫引号/花括号/换行破坏；
3. 转成 OpenAI 标准 `tool_calls` 返回（`finish_reason: "tool_calls"`）；
4. 客户端执行工具后，把 `role: "tool"` 的结果发回，桥接层把结果**键入页面**续聊。

**关键增强（与 deepseek-cdp-bridge 同构）**：
- **content 与 tool_calls 不再互斥**：模型"先说一句 + 再调工具"时，正文与工具调用同时返回（旧方案会丢弃正文）。
- **流式场景**：`ToolStreamSieve` 逐字符分离正文与工具调用，正文实时吐出、工具调用块闭合后才 flush。
- **容错**：模型偶发把结束标签写成 `</<|DSML|parameter>`（多了一个 `<`）时，解析器先归一化为规范的 `</|DSML|parameter>` 再解析，避免整段 DSML 泄漏为原样正文。
- **向后兼容**：旧版 `__TOOL_CALL__{"name":…,"arguments":{…}}__END__` 定界符仍可被解析（保留下划线宽松、尾逗号、字符串化 arguments 等容错），仅解析兼容，注入格式已统一切换为 DSML。

**注意事项**：
- 这是**基于提示词的尽力而为方案**：可靠性取决于网页模型对 DSML 格式的遵循度；模型偶尔可能输出多余文字或漏掉格式，此时会按普通回答处理（不触发 `tool_calls`）。
- 注入的工具说明前缀会**出现在 Qwen 网页对话里**，属该方案的固有代价。

### 3.7 工具提示词按需注入：`HI,TOOLS` 会话级一次性注入（省 prompt）

由于上层 agent 每次请求都携带 `tools`，若每轮都把庞大的工具说明前缀注入网页模型，对话上下文与 token 成本会显著膨胀。本桥改为**只在识别到指令 `HI,TOOLS` 时，带上系统提示词发送一次 `HI` 消息**：

- **默认一直不发送**：会话从未发送过 `HI,TOOLS` 时，即使请求带 `tools`，桥接层也**不发送**工具系统提示词，网页模型按普通问答处理（不会触发 `tool_calls`）。
- **识别到即向网页发 `HI`（代替 `HI,TOOLS` 文本）**：请求中的 user 消息含 `HI,TOOLS`（大小写/空格宽松匹配，如 `HI, TOOLS`）时，桥接层**不把 `HI,TOOLS` 文本发给网页**，而是发送 `系统提示词 + HI`（首次带 tools 时内容为 `系统提示词\n\nHI`；仅这一次）。
- **返回网页真实回复（2026-08-21 调整）**：该回合不再由服务器伪造 `HI` 确认响应，而是把 `HI` 真正发给网页后，将**网页的真实回复**返回给客户端（流式按增量推送）。指令本身只负责触发系统提示词添加。
- **同会话不再带提示词**：本会话（同一 `session_id`）后续所有请求（含再次发 `HI,TOOLS`）都**不再带系统提示词**——再次发 `HI,TOOLS` 只发 `HI`。系统提示词留在网页会话历史中，后续带 `tools` 的请求直接发真实提问，模型依据历史中的提示词产生 `tool_calls`。

- **识别条件=最后一次用户消息**：客户端常携带多轮历史（其中含以前的 `HI,TOOLS` 指令），桥接层**只识别最后一次用户消息**——历史里的旧 `HI,TOOLS` 不会触发握手，只有最新一次用户指令是 `HI,TOOLS` 才算。

> 依赖：握手归属"当前会话"——请用**相同 `session_id`** 复用在同一网页会话；若发 `NEW.TOPIC` 指令或 `new_session: true` 新建会话，新会话历史中没有提示词，需要在新会话里再发一次 `HI,TOOLS`（带 `tools`）。`HI,TOOLS` 应作为独立回合发送（带 `tools` 参数），若与真实提问混在同一回合，该回合会被当作握手处理、提问不转发（只向网页发 `HI`，返回网页对 `HI` 的回复）。进程重启后注入状态清空。

### 3.8 WorkBuddy 专有格式支持（`<user_query>` 标签）

WorkBuddy 客户端调用时，user 消息里总是附带系统提示词，**真实用户消息由 `<user_query>...</user_query>` 标签包裹**。桥接层会自动解析该格式（`tooluse.extractUserQuery`）：

- **非 `HI,TOOLS` 时只传真实消息**：发给网页模型的内容 = `<user_query>` 标签内的文本（不含客户端附加的系统提示词、不含标签本身），避免 WorkBuddy 系统提示词污染网页会话上下文。
- **指令优先在真实消息上解析**：`NEW.TOPIC` / `HI,TOOLS` 均在提取后的真实消息上检测（`<user_query>NEW.TOPIC</user_query>` 同样触发新建会话）。
- **`HI,TOOLS` 时注入全部系统提示词**：仅在 `HI,TOOLS` 指令回合注入工具系统提示词（见 3.7），其余回合一律不注入。
- 无 `<user_query>` 标签的消息（普通 OpenAI 客户端）原样传递，完全兼容。

---

## 4. 客户端接入示例

### 4.1 Python（openai SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",   # 指向本服务
    api_key="sk-any",                       # 任意值，本服务不校验
)

resp = client.chat.completions.create(
    model="qwen-web",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

### 4.2 curl

```bash
# 非流式
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-web","messages":[{"role":"user","content":"你好"}]}'

# 流式（-N 实时输出）
curl -N -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-web","messages":[{"role":"user","content":"你好"}],"stream":true}'

# 新建会话：发一条 NEW.TOPIC 指令（回显 NEW.TOPIC，不转发给模型）
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-web","messages":[{"role":"user","content":"NEW.TOPIC"}]}'
```

### 4.3 其他工具

| 工具 | 配置 |
|---|---|
| OpenWebUI / LobeChat / NextChat 等 | OpenAI 兼容提供商，`base_url = http://localhost:3001/v1`，`api_key` 任意，模型名填 `qwen-web`（或别名） |
| DSH 等 Agent 工具 | 指向该 base_url 作为 OpenAI 兼容模型端点 |

---

## 5. 限制与注意事项

| 项目 | 说明 |
|---|---|
| **单页面串行** | 同页面同一份对话上下文，请求严格串行（排队），并发会排队等待而非并行 |
| **登录态** | 依赖 Chrome 窗口保持登录；登录过期/验证码会导致超时（60s），把页面切回聊天页并重新登录即可 |
| **CDP 连接** | 服务端显式用 `127.0.0.1:9222` 连接 Chrome（Chrome 调试端口默认仅监听 IPv4，且新版 Node 解析 `localhost` 可能优先 `::1` 被拒）。如确有需要可用环境变量 `CDP_HOST` 覆盖 |
| **页面改版** | 输入框/发送按钮/回复元素选择器基于当前页面结构（**2026-08-21 实测**），改版后需更新 `cdp-controller.js` 中的选择器，可用 `_debug_page.js` 重新探测 |
| **思考模式** | 网页「深度思考」开启时需等待思考+回答全部结束才返回（思考内容自动从回答中排除，见 3.5） |
| **SSE 格式** | Qwen v2 接口结束帧为 `delta.status="finished"`（无 `[DONE]`/`finish_reason`），解析器已适配；接口升级时用 `_capture_probe.js` 重新抓取原始流校验 |
| **代码块渲染** | SSE 协议级捕获直接解析 HTTP 流式响应，不依赖页面渲染，代码块完整返回 |
| **合规性** | 自动化操作网页违反 Qwen 网页版服务条款，有封号风险，仅限个人低频自用 |
| **工具调用** | 基于提示词约定（非官方 API），可靠性取决于网页模型对格式的遵循；工具说明会显示在网页对话中 |
| **多账号** | 多账号并发需多 Chrome 实例（多端口）+ 多控制器实例 |

---

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CDP_PORT` | `9222` | Chrome 远程调试端口（可与 deepseek 桥共用） |
| `API_PORT` | `3001` | 本服务监听端口（默认避开 deepseek 桥的 3000） |
| `RESPONSE_TIMEOUT` | `60000` | 单次请求超时（毫秒） |
| `STABLE_MS` | `3000` | DOM 兜底时流式静默稳定窗口（毫秒） |
| `QWEN_SELECTOR` | 内置链 | DOM 兜底选择器覆盖（逗号分隔的 CSS 选择器） |

---

## 7. 调试日志解读

| 日志 | 含义 |
|---|---|
| `[cdp] 已连接页面: https://chat.qwen.ai/...` | 成功连上登录页面 |
| `[cdp] API请求: https://chat.qwen.ai/api/v2/chat/completions?...` | 页面发出对话请求（Qwen 真实接口，v2） |
| `[cdp] 已写入文本（一次性写入，N/N 字）` | 文本注入成功 |
| `[cdp] 已点击发送（第 N 次尝试）` | 内容就绪后点击发送按钮 |
| `[cdp] 响应预览(...)` | Network 层抓到的响应开头（仅诊断） |
| `[cdp] 会话 xxx 捕获到回复(SSE, N字)` | SSE 协议级捕获到完整回复（主路径） |
| `[cdp] 会话 xxx 捕获到回复(DOM兜底, N字)` | SSE 未捕获到，回退 DOM 读取（兜底路径） |
| `[api] sessionId=xxx 失败: ...` | 请求失败及原因 |

---

## 8. 实测记录（2026-08-21）

### 8.1 页面结构（chat.qwen.ai）

| 元素 | 实测选择器/特征 |
|---|---|
| 输入框 | `textarea.message-input-textarea`（原生 textarea，非 contenteditable） |
| 发送按钮 | `button[aria-label="发送"]`（class `send-button`，常驻可点） |
| 新建对话 | `div[aria-label="新建对话"]`（侧边栏入口，非 button） |
| 助手回复正文（纯净） | `div.response-message-content`（t2t phase-answer，不含思考） |
| 消息容器 | `div.qwen-chat-message.qwen-chat-message-assistant` |
| 模型选择器 | `div[aria-label="Select Model"]`（当前如 Qwen3.8-Max） |
| 会话 URL | `https://chat.qwen.ai/c/<uuid>` |

### 8.2 对话接口与 SSE 格式（v2）

接口：`POST https://chat.qwen.ai/api/v2/chat/completions?chat_id=<uuid>`

```
data: {"response.created":{"chat_id":"...","parent_id":"...","response_id":"...","response_index":"0"}}
data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"thinking_summary","extra":{"summary_thought":{"content":["思考摘要数组"]}},"status":"typing"}}],...}
data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"thinking_summary","status":"finished"}}],...}        ← 思考结束
data: {"choices":[{"delta":{"role":"assistant","content":"完整回答快照","phase":"answer","status":"typing"}}],...}         ← 回答（快照式，每帧含全文）
data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}],...}                  ← 结束帧（无 [DONE]/finish_reason）
```

解析要点：
- 结束信号 = `delta.status === "finished"`（已兼容 OpenAI 兼容的 `finish_reason` 与 `[DONE]`）
- 回答为**快照式**（每帧含完整回答），解析器做快照/增量自适应去重
- 思考内容在 `delta.extra.summary_thought.content`，**自动排除**，只回传最终回答
- 原始捕获样本见 `_captured_sse.txt`（真实抓包）

### 8.3 关键坑（Qwen 特有，与 deepseek 桥不同）

1. **页面内 `setTimeout` 被站点脚本包装**：CDP `Runtime.evaluate` + `awaitPromise` 等待页面定时器会**永久挂起**。文本注入必须**全同步**（原生 value setter + input 事件），框架提交状态的时间在 Node 侧等待。这是首个版本卡死的根因。
2. **SSE 无 `[DONE]`/`finish_reason`**：结束帧是 `delta.status:"finished"`，初始版本的结束检测漏掉它导致 SSE 永不结算、回退 DOM。
3. **DOM 兜底基准**：必须用**发送前**的快照做基准——超时后再拍快照时回复已渲染，基准相同会永远检测不到"新回复"。

---

## 9. 项目文件

| 文件 | 说明 |
|---|---|
| `api-server.js` | API 服务器：OpenAI 兼容端点 + 模型路由校验 + 串行队列 + 错误处理 |
| `models.js` | 模型路由注册表：内置 `qwen-web` + 常用别名映射 + `/v1/models` 列表（改模型只动这里） |
| `tooluse.js` | 工具调用层（DSML）：把 OpenAI `tools` 转为 DSML 提示词注入、抽取 `<|DSML|…>` 工具调用（含 CDATA 参数解析/自动类型）、`ToolStreamSieve` 流筛分引擎、旧 `__TOOL_CALL__` 向后兼容、反查工具名 |
| `cdp-controller.js` | CDP 控制器：连接页面、一次性写入文本 + 发送、按模型切换网页模式、SSE 捕获 + DOM 兜底 |
| `_sse_selftest.js` | SSE 解析器离线自测（`npm run selftest`），覆盖增量/快照/思考排除/结束检测 |
| `_debug_page.js` | 页面结构探测工具：页面改版后重新确认选择器 |
| `_capture_probe.js` | 原始 SSE 捕获工具：改版后重新抓取真实流格式（输出 `_captured_sse.txt`） |
| `_captured_sse.txt` / `_captured_dom.json` | 实测抓包样本（2026-08-21），供解析器/选择器校准参考 |
| `package.json` | 依赖：express、chrome-remote-interface |

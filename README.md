# DeepSeek CDP Bridge

把**已登录的 DeepSeek 网页版**（chat.deepseek.com）包装成 **OpenAI / DeepSeek 标准兼容 API** 的本地服务。

用网页版免费额度跑对话，任何 OpenAI 兼容客户端（openai SDK、DSH、OpenWebUI、LobeChat 等）把 `base_url` 指向本服务即可直接使用，无需 API Key。

---

## 1. 工作原理

```
客户端(OpenAI格式) → /v1/chat/completions → 串行队列
      → CDP 控制器 → Chrome(9222 调试端口) 中的 chat.deepseek.com 页面
      → 一次性写入文本+发送 → DeepSeek 流式响应 → SSE 协议级捕获完整回复 → 返回
      （SSE 未捕获到时，自动回退 DOM 轮询）
```

- **CDP**（Chrome DevTools Protocol）：连接你已打开的 Chrome，控制真实登录会话
- **SSE 捕获（主路径）**：`Network.dataReceived` 在协议层累积 `/api/v0/chat/completion` 的流式响应（增量式 SSE，每帧一个字符/词），检测到 `FINISHED` 结束信号后解析出**完整回复**（含代码块）——不依赖页面渲染，天然免疫页面代码块渲染 bug
- **DOM 兜底**：SSE 拿不到时（请求走非 HTTP 通道），回退读取页面 `div.ds-assistant-message-main-content`
- **串行队列**：一次只处理一个会话，杜绝多请求并发串话

> 注意：本质是「模拟真实网页操作」，**违反 DeepSeek 网页版服务条款**，仅限个人低频自用。正式场景请使用 DeepSeek 官方 API（`api.deepseek.com`）。

---

## 2. 快速开始

### 2.1 启动 Chrome（独立用户目录，与日常浏览器隔离）

```bash
chrome --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-debug
```

然后在该 Chrome 中打开 **https://chat.deepseek.com** 并登录，**保持窗口打开**。

> 调试端口默认只监听 127.0.0.1，局域网/公网无法访问。切勿加 `--remote-debugging-address=0.0.0.0`。

### 2.2 启动服务

```bash
cd D:/wkdata/AI/DSH/dsapi/deepseek-cdp-bridge
npm install      # 首次
npm start
```

看到日志 `已连接页面: https://chat.deepseek.com/...` 即就绪。

### 2.3 验证

```powershell
# PowerShell（注意 --% 停止解析 + \" 转义）
curl.exe --% -X POST http://localhost:3000/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"deepseek-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

```bash
# Git Bash（单引号即可）
curl -X POST http://localhost:3000/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

---

## 3. API 说明

### 3.1 `POST /v1/chat/completions`（标准接口，推荐）

同时支持别名路径 `POST /chat/completions`。

**请求体**（OpenAI / DeepSeek 标准格式）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 否 | 模型路由字段（见 3.5）。不填默认 `deepseek-web`；支持常见别名（`deepseek-chat` / `deepseek-reasoner` / `deepseek-coder` / `deepseek-v3` / `deepseek-r1` / `deepseek-ai/*` 等），全部路由到内置 `deepseek-web`。未知模型返回 400 |
| `messages` | array | **是** | 对话消息数组，取最后一条 `role: "user"` 的内容发送 |
| `stream` | boolean | 否 | `false`（默认）返回完整 JSON；`true` 返回 SSE 流式增量 |
| `new_session` | boolean | 否 | 显式控制新建会话（可选）。不传时：若请求带了 `session_id` 且与上次不同 → **自动新建**（见 3.3）；`true` 强制新建、`false` 强制不新建 |
| `session_id` | string | 否 | 自定义会话 ID（可选，默认自动生成） |
| `max_tokens` | number | 否 | 忽略（网页版不受控） |

**非流式响应**（`stream: false`）：

```json
{
  "id": "chatcmpl-session_1787195058618_ua4x7sbie",
  "object": "chat.completion",
  "created": 1787195063,
  "model": "deepseek-web",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "88" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 7 }
}
```

> `usage` 为**估算值**（网页版不返回真实 token 用量），仅供粗略参考。

**流式响应**（`stream: true`，SSE）：

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"77"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**错误响应**（OpenAI 标准结构）：

```json
{
  "error": {
    "message": "messages 必须是非空数组",
    "type": "invalid_request_error",
    "code": "invalid_messages"
  }
}
```

### 3.2 `POST /chat`（旧版简单接口，向后兼容）

```json
// 请求
{ "message": "你好", "sessionId": "可选", "newSession": true }
// 响应
{ "success": true, "sessionId": "...", "content": "...", "newSession": true, "timestamp": "..." }
```

> `newSession: true` 与标准接口的 `new_session: true` 等价，发送前新建空白会话。旧接口的 `sessionId` 同样参与会话切换自动检测（见 3.3）。

### 3.3 新建会话（自动检测 + 显式控制）

**方式一：自动检测（推荐，客户端零改动）**

服务器会跟踪客户端传入的 `session_id`：当请求的 `session_id` 与上一次请求不同时，判定客户端已新建会话，**自动**在网页版开一个全新会话再发送——客户端（如 OpenWebUI、DSH 等）点"新会话"时天然会换新会话 id，无需任何额外字段。

```json
// 客户端第一次：session_id 记为 sess-A → 使用当前页面
{ "messages": [{ "role": "user", "content": "你好" }], "session_id": "sess-A" }
// 同一会话继续：session_id 仍是 sess-A → 同页面继续
{ "messages": [{ "role": "user", "content": "继续说" }], "session_id": "sess-A" }
// 客户端新建会话：session_id 变为 sess-B → 自动新建页面会话 ✓
{ "messages": [{ "role": "user", "content": "你好" }], "session_id": "sess-B" }
```

> 仅当请求**显式携带** `session_id` 时启用自动检测；不带 `session_id` 的请求（服务端生成随机 id）不会触发新建，维持旧行为。服务日志会打印 `new_session=true（会话切换自动检测）` 与 `已新建会话: <旧URL> -> <新URL>`。

**方式二：显式字段**（仍需手动控制时）

标准接口请求体加 `"new_session": true`（旧接口 `"newSession": true`）强制新建；`"new_session": false` 强制不新建（优先级高于自动检测）。

**方式三：控制指令 `NEW.TOPIC`**（无需 `session_id` 字段）

最后一条 user 消息内容为 `NEW.TOPIC`（大小写/空格/点号宽松匹配，`new topic`、`NEW TOPIC` 均可；`<user_query>NEW.TOPIC</user_query>` 同样触发）时，桥接层**静默新建网页会话**并回显 `NEW.TOPIC`，**不把指令转发给网页模型**。新建在串行队列中 fire-and-forget 执行：确认回执立即返回，下一条消息排在新建之后执行，天然落在新会话（上下文隔离）。注意：该指令只控制网页会话的新建，不与真实提问混在同一回合（混在一起会被当作普通消息处理）。

```json
// 单独发一条 NEW.TOPIC 指令 → 新建网页会话，回显 "NEW.TOPIC"
{ "model": "deepseek-chat", "messages": [{ "role": "user", "content": "NEW.TOPIC" }] }
// 然后发真实提问 → 落在新建的网页会话中
{ "model": "deepseek-chat", "messages": [{ "role": "user", "content": "你好" }] }
```

> 实现说明：DeepSeek 网页版"新建对话"按钮的 class 为混淆名、无文字/aria 标签，无法用静态选择器定位；`newSession()` 改为行为探测——遍历少量候选 `[role="button"]`，点哪个会让页面 URL 跳到根路径（离开旧 `/a/chat/s/<id>`）即命中，点错则还原现场。裸 `fetch` 调用会话创建 API 因缺少应用动态计算的鉴权/PoW 头（`authorization`、`x-ds-pow-response` 等）会返回 `Missing Token`，故一律走按钮方式。

### 3.4 CORS（浏览器前端直接调用）

服务已启用 CORS，允许任意来源的浏览器页面直接 `fetch` 本服务（含 OPTIONS 预检），前端无需走代理：

```js
// 浏览器前端示例
const resp = await fetch('http://localhost:3000/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '你好' }],
    session_id: 'my-chat-1',   // 换新值即自动新建会话
  }),
});
const data = await resp.json();
console.log(data.choices[0].message.content);
```

> 响应头：`Access-Control-Allow-Origin: *`、允许 `Content-Type/Authorization/x-session-id` 等请求头；预检结果缓存 24h。

### 3.5 模型路由（内置 `deepseek-web`）

本服务内置一个 canonical 模型 **`deepseek-web`**（经 CDP 桥接的 DeepSeek 网页版），并兼容一批常见别名，全部收敛路由到该后端。

**GET `/v1/models`**（及别名 `/models`）返回 OpenAI 标准模型列表：

```bash
curl http://localhost:3000/v1/models
# → {"object":"list","data":[{"id":"deepseek-web","object":"model","owned_by":"deepseek-cdp-bridge",...},
#     {"id":"deepseek-chat","alias_of":"deepseek-web",...}, ...]}
```

**支持的模型名称**（客户端 `model` 字段，大小写不敏感）：

| 名称 | 路由目标 | 备注 |
|---|---|---|
| `deepseek-web` | 自身（内置） | canonical 模型，默认 |
| `deepseek` / `deepseek-chat` / `deepseek-v3` / `deepseek-coder` | `deepseek-web` | 对话/代码别名 |
| `deepseek-reasoner` / `deepseek-r1` | `deepseek-web` | 深度思考（R1）别名，会尽力开启网页「深度思考」 |
| `deepseek-ai/deepseek-chat` / `deepseek-ai/deepseek-reasoner` / `deepseek-ai/deepseek-coder` | `deepseek-web` | deepseek-ai 命名空间别名 |

- **未识别的模型**（如 `gpt-4o`）→ 返回 `400 invalid_model`，错误信息提示查 `GET /v1/models`。
- **响应回显的 `model`**：别名请求会收敛为 canonical 名（`deepseek-web`），便于上层按真实模型记录。
- **模型模式联动（尽力而为）**：当 `model` 暗示特定模式时，桥接层会在发送前**尽力**切换网页开关——`reasoner`/`r1` 开启「深度思考」，名称含 `search`/`联网`/`online` 开启「联网搜索」，其余关闭深度思考。找不到开关或点击失败仅记警告，不阻断发送。因网页版最终模型由登录账号 UI 状态决定，联动为“尽力”而非保证。

> 路由规则集中在 `models.js`，新增模型/后端只需改这一个文件，无需碰 `api-server.js`。

### 3.6 工具调用（Tool Use / Function Calling）

DeepSeek **网页版没有原生的 function-calling 协议**（不像官方 `api.deepseek.com` API），本桥靠"键入文本 + 读回回复"驱动模型。为支持 OpenAI 的 `tools`/`tool_calls`，本服务用一套**约定格式（TOOLSXML，DeepSeek Markup Language）**让网页模型"假装"支持工具调用（见 `tooluse.js`）：

1. 请求带 `tools` 时，桥接层把**工具清单 + 调用规则（TOOLSXML 格式说明）**作为前缀注入到用户消息里发给 DeepSeek；
2. 捕获回复，用 TOOLSXML 标签 `<|TOOLSXML|tool_calls>` → `<|TOOLSXML|invoke name="…">` → `<|TOOLSXML|parameter name="…"><![CDATA[…]]></|TOOLSXML|parameter>` 抽取工具调用；字符串参数值放在 `<![CDATA[…]]>` 中，天然免疫引号/花括号/换行破坏；
3. 转成 OpenAI 标准 `tool_calls` 返回（`finish_reason: "tool_calls"`）；**正文与工具调用可共存**——模型"先说一句再调工具"时，正文会作为 `content` 一并返回（不再是旧版的互斥丢弃）；
4. 客户端执行工具后，把 `role: "tool"` 的结果发回，桥接层把结果**键入页面**续聊，模型据此给出最终答案。

> **TOOLSXML 设计借鉴** `deepseek-web2api-free` 项目的 TOOLSXML + StreamSieve 思路，并做了两点关键增强：① content 与 tool_calls 不再互斥；② 流式场景下用 `ToolStreamSieve` 逐字符分离正文与工具调用，正文实时吐出、工具调用块闭合后才 flush。

**请求示例（带工具）：**

```json
{
  "model": "deepseek-web",
  "messages": [{ "role": "user", "content": "北京天气怎么样？" }],
  "tools": [
    { "type": "function", "function": {
        "name": "get_weather",
        "description": "查询城市天气",
        "parameters": { "type": "object", "properties": { "location": { "type": "string" } }, "required": ["location"] }
    }}
  ],
  "tool_choice": "auto"   // auto(默认) | none | required | {"type":"function","function":{"name":"x"}}
}
```

**第一轮响应（模型先说明再调工具，正文与 tool_calls 共存）：**

```json
{
  "id": "chatcmpl-...", "object": "chat.completion", "model": "deepseek-web",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "我来帮你查一下。",
      "tool_calls": [{ "id": "call_xxx_0", "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"location\":\"北京\"}" } }] },
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 38, "completion_tokens": 1, "total_tokens": 39 }
}
```

> `content` 为空时返回 `null`；有正文时返回正文。客户端应同时处理这两种情况。

**第二轮（客户端回传工具结果，继续对话）：**

```json
{
  "model": "deepseek-web",
  "messages": [
    { "role": "user", "content": "北京天气怎么样？" },
    { "role": "assistant", "tool_calls": [{ "id": "call_xxx_0", "type": "function", "function": { "name": "get_weather", "arguments": "{\"location\":\"北京\"}" } }] },
    { "role": "tool", "tool_call_id": "call_xxx_0", "content": "晴 25°C" }
  ]
}
```

> 流式（`stream: true`）同样支持：正文以 `delta.content` 增量帧**实时**吐出，工具调用以 `delta.tool_calls` 帧在块闭合后返回，结束帧 `finish_reason` 据是否存在工具调用取 `"tool_calls"` 或 `"stop"`，后跟 `[DONE]`。

**注意事项（重要）：**
- 这是**基于提示词的尽力而为方案**：可靠性取决于网页模型对 TOOLSXML 格式的遵循度；模型偶尔可能输出多余文字或漏掉格式，此时会按普通回答处理（不触发 `tool_calls`）。
- 注入的工具说明前缀会**出现在 DeepSeek 网页对话里**（作为可见消息的一部分），属该方案的固有代价。
- `arguments` 由模型生成，桥接层做 JSON 解析 / CDATA 提取 / 自动类型转换（数字、布尔、null）与透传，不校验 schema；客户端应自行校验参数。
- **向后兼容**：旧版 `__TOOL_CALL__{"name":…,"arguments":{…}}__END__` 定界符仍可被解析（仅解析兼容，注入格式已统一切换为 TOOLSXML）。
- 普通正文若含 `<`（如 `1 < 2`）不会被误判为工具调用；异常超长未闭合的工具块会触发缓冲上限保护，强制当正文吐出，避免卡死。
- **容错**：模型偶发把结束标签写成 `</<|TOOLSXML|parameter>`（多了一个 `<`）时，解析器会先归一化为规范的 `</|TOOLSXML|parameter>` 再解析，避免整段 TOOLSXML 泄漏为原样正文；提示词也明确警告模型不要双写 `<`。

### 3.6.1 客户端确认续轮处理（修复「已确认却仍等待确认」）

默认（也是唯一）模式下，桥把 `tool_calls` **透传**给客户端，由客户端（DSH / OpenWebUI / WorkBuddy 等）在其自身环境执行工具、再把 `role:"tool"` 的结果发回。桥**不**代替客户端执行或决策工具——工具语义、权限确认都在客户端完成。此处只解决"续轮"的协议衔接问题：

**续轮处理（无状态透明中继，参照 qwen-cdp 简化语义，无 `forceFinal`/闸门/拦截）**：
- 续轮判定：**只看"最后一条消息是不是 `role:tool`"**——是 → 把该条结果（**仅一条**，以 `【工具「name」的返回结果如下，请据此继续完成任务】` 标注）键入页面供模型继续；否则取最后一条 user 消息发送。
- 桥**不做任何状态跟踪**（无 pending 闸门、无防重键入、无 400 拦截）：客户端发什么就键入什么、网页回什么就回传什么，控制权始终在客户端。
- **为何不加闸门**：此前加的"待处理 tool_calls 匹配 / 重复问题 400"逻辑在客户端 agent 卡死循环时反而误伤——① 把客户端执行错误（如 `AskUserQuestion` 格式失败）当有效结果回灌页面；② 返回 400 让客户端把工具确认当作"被拒"而**自动跳过确认、卡死在等待确认点**。去掉后回归忠实中继。
- 桥**绝不**向网页注入"不要再调用工具"等指令、**绝不**隐藏 `tool_calls`、**绝不**替客户端作答或自动执行工具。

**客户端接入铁律**：
- 第一轮（带 `tools`）：收到 `finish_reason:"tool_calls"` 即执行工具，把结果以 `role:"tool"` 发回，**不要**再用同一请求重复发原始提问；
- 第二轮（含 `role:"tool"`）：桥按网页真实返回中继——若网页仍产出 `tool_calls` 则继续回传 `tool_calls`（客户端再次执行并回传），若网页给出最终答案则返回 `stop` + `content`，客户端据此收尾。

> 注：`HI,TOOLS` 注入工具说明的回合仍需先发一次（同一 `session_id`），模型才会产出可被解析的 `tool_calls`（见 3.7）。`tool_executor` 字段本桥已不再使用（工具由客户端自执行）。

### 3.7 工具提示词按需注入：`HI,TOOLS` 会话级一次性注入（省 prompt）

由于上层 agent 每次请求都携带 `tools`，若每轮都把庞大的工具说明前缀注入网页模型，对话上下文与 token 成本会显著膨胀。本桥改为**只在识别到指令 `HI,TOOLS` 时，带上系统提示词发送一次 `HI` 消息**：

- **默认一直不发送**：会话从未发送过 `HI,TOOLS` 时，即使请求带 `tools`，桥接层也**不发送**工具系统提示词，网页模型按普通问答处理（不会触发 `tool_calls`）。
- **识别到即带提示词发 `HI`**：请求中的 user 消息含 `HI,TOOLS`（大小写/空格宽松匹配，如 `HI, TOOLS`）时，桥接层把**系统提示词 + `HI` 消息**作为发给网页模型的内容（`系统提示词\n\nHI`），**仅这一次**（同一 `session_id` 后续不再带）。
- **返回网页真实回复（2026-08-21 调整）**：该回合不再由服务器伪造 `HI` 确认应答，而是把 `HI` 真正发给网页后，将**网页的真实回复**返回给客户端（流式按增量推送）。指令本身只负责触发系统提示词添加。
- **同会话不再带提示词**：本会话（同一 `session_id`）后续所有请求（含再次发 `HI,TOOLS`）都**不再带系统提示词**——再次发 `HI,TOOLS` 只发 `HI`。系统提示词留在网页会话历史中，后续带 `tools` 的请求直接发真实提问，模型依据历史中的提示词产生 `tool_calls`。

- **识别条件=最后一次用户消息**：客户端常携带多轮历史（其中含以前的 `HI,TOOLS` 指令），桥接层**只识别最后一次用户消息**——历史里的旧 `HI,TOOLS` 不会触发握手，只有最新一次用户指令是 `HI,TOOLS` 才算。

> 依赖：握手归属"当前会话"——请用**相同 `session_id`** 复用在同一网页会话；若换 `session_id` 或 `new_session` 新建会话，新会话历史中没有提示词，需要在新会话里再发一次 `HI,TOOLS`（带 `tools`）。`HI,TOOLS` 应作为独立回合发送（带 `tools` 参数），若与真实提问混在同一回合，该回合会被当作握手处理、提问不转发。进程重启后注入状态清空。

### 3.8 WorkBuddy 专有格式支持（`<user_query>` 标签）

WorkBuddy 客户端调用时，user 消息里总是附带系统提示词，**真实用户消息由 `<user_query>...</user_query>` 标签包裹**。桥接层会自动解析该格式（`tooluse.extractUserQuery`）：

- **非 `HI,TOOLS` 时只传真实消息**：发给网页模型的内容 = `<user_query>` 标签内的文本（不含客户端附加的系统提示词、不含标签本身），避免 WorkBuddy 系统提示词污染网页会话上下文。
- **指令优先在真实消息上解析**：`NEW.TOPIC` / `HI,TOOLS` 均在提取后的真实消息上检测（`<user_query>NEW.TOPIC</user_query>` 同样触发新建会话；`<user_query>HI,TOOLS</user_query>` 同样触发握手）。
- **`HI,TOOLS` 时注入全部系统提示词**：仅在 `HI,TOOLS` 指令回合注入工具系统提示词（见 3.7），其余回合一律不注入。
- 无 `<user_query>` 标签的消息（普通 OpenAI 客户端）原样传递，完全兼容。

---

## 4. 客户端接入示例

### 4.1 Python（openai SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",   # 指向本服务
    api_key="sk-any",                       # 任意值，本服务不校验
)

# 非流式
resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)

# 流式
resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in resp:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

### 4.2 curl

```bash
# Git Bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'

# 流式（-N 实时输出）
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

### 4.3 其他工具

| 工具 | 配置 |
|---|---|
| OpenWebUI / LobeChat / NextChat 等 | OpenAI 兼容提供商，`base_url = http://localhost:3000/v1`，`api_key` 任意，模型名填 `deepseek-web`（或支持的别名，见 3.5） |
| DSH 等 Agent 工具 | 指向该 base_url 作为 OpenAI 兼容模型端点，模型名用 `deepseek-web` 或别名 |

---

## 5. 限制与注意事项

| 项目 | 说明 |
|---|---|
| **单页面串行** | 同页面同一份对话上下文，请求严格串行（排队），并发会排队等待而非并行 |
| **登录态** | 依赖 Chrome 窗口保持登录；登录过期/验证码会导致超时（60s），把页面切回聊天页并重新登录即可 |
| **页面改版** | 输入框/发送按钮/回复元素选择器基于当前页面结构（2026-08-20 实测），改版后需更新 `cdp-controller.js` 中的选择器 |
| **思考模式** | 若开启「深度思考」，需等待思考+回答全部结束才返回（文本稳定 3s 判据），非提前返回 |
| **代码块渲染（已解决）** | 早期 DOM 捕获依赖页面渲染，而 DeepSeek 页面存在代码块渲染偶发失败（`<pre>` 空白）。**SSE 协议级捕获直接解析 HTTP 流式响应，不再依赖页面渲染**，代码块完整返回。仅当请求不走 HTTP SSE（罕见）回退 DOM 时才会受此影响 |
| **合规性** | 自动化操作网页违反 DeepSeek 网页版服务条款，有封号风险，仅限个人低频自用 |
| **工具调用** | 基于提示词约定（非官方 API），可靠性取决于网页模型对格式的遵循；工具说明会显示在网页对话中 |
| **多账号** | 多账号并发需多 Chrome 实例（多端口）+ 多控制器实例 |

---

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CDP_PORT` | `9222` | Chrome 远程调试端口 |
| `API_PORT` | `3000` | 本服务监听端口 |
| `RESPONSE_TIMEOUT` | `60000` | 单次请求超时（毫秒） |
| `STABLE_MS` | `3000` | 流式静默稳定窗口（毫秒）。文本连续该时间不变视为流式结束；调大可给代码块高亮更多渲染时间 |

---

## 7. 调试日志解读

服务启动后终端日志含义：

| 日志 | 含义 |
|---|---|
| `[cdp] 已连接页面: https://chat.deepseek.com/...` | 成功连上登录页面 |
| `[cdp] API请求: https://chat.deepseek.com/api/v0/chat/completion` | 页面发出对话请求（DeepSeek 真实接口） |
| `[cdp] 已点击发送（第 N 次尝试）` | 内容就绪后点击发送按钮（框架需约 ≤3s 把写入的内容注册进内部状态，期间会重试点击直到输入框被清空） |
| `[cdp] 响应预览(...)` | Network 层抓到的响应开头（仅诊断） |
| `[cdp] 会话 xxx 捕获到回复(SSE, N字)` | SSE 协议级捕获到完整回复（主路径），N 为字数 |
| `[cdp] 会话 xxx 捕获到回复(DOM兜底, N字)` | SSE 未捕获到，回退 DOM 读取（兜底路径） |
| `[cdp] ⚠️ 代码块围栏不配对 / <pre> 少于...` | DOM 兜底时检测到代码块可能未完整渲染 |
| `[api] sessionId=xxx 失败: ...` | 请求失败及原因 |

---

## 8. 项目文件

| 文件 | 说明 |
|---|---|
| `api-server.js` | API 服务器：OpenAI 兼容端点 + 模型路由校验 + 串行队列 + 错误处理 |
| `models.js` | 模型路由注册表：内置 `deepseek-web` + 常用别名映射 + `/v1/models` 列表（改模型只动这里） |
| `tooluse.js` | 工具调用层（TOOLSXML）：把 OpenAI `tools` 转为 TOOLSXML 提示词注入、抽取 `<|TOOLSXML|…>` 工具调用（含 CDATA 参数解析/自动类型）、`ToolStreamSieve` 流筛分引擎、旧 `__TOOL_CALL__` 向后兼容、反查工具名 |
| `tooluse.test.js` | 纯逻辑单元测试（无需 Chrome）：TOOLSXML 解析、CDATA 特殊字符、多 invoke、旧格式兼容、`ToolStreamSieve` 流分离；`node tooluse.test.js` 运行 |
| `cdp-controller.js` | CDP 控制器：连接页面、一次性写入文本（不粘贴/不重复录入）+ 发送、按模型切换网页模式、DOM 轮询捕获回复 |
| `page-hook.js` | **已弃用**（早期页面内 hook 方案，死代码，可删除） |
| `package.json` | 依赖：express、chrome-remote-interface |

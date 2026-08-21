// models.js —— 模型路由注册表（Qwen AI 网页版桥）
//
// 把 OpenAI / DashScope 客户端常用的 model 名称统一路由到具体后端。
// 当前唯一内置后端：qwen-web（经 Chrome CDP 桥接已登录的 chat.qwen.ai 网页）。
//
// 设计目标：
//   1. 内置 canonical 模型 `qwen-web`，作为本服务对外暴露的"招牌模型"。
//   2. 兼容常见别名（qwen-max / qwen-plus / qwen-turbo / qwen3 / qwen2.5-coder /
//      qwen3-coder / qwen-omni / DashScope 命名空间 qwen/* 等），全部路由到 qwen-web。
//   3. 提供 OpenAI 标准的 /v1/models 列表接口。
//   4. 模型名可携带模式后缀（-thinking / -search），桥接层据此尽力切换网页模式。
//   5. 后端可扩展：未来可加入新 backend（如真实 DashScope API key 后端）而不必改 api-server。
//
// 重要：本路由表只是"配置方便"，不是白名单限制。
//   本代理本质只有网页版一个后端，因此对任何未知 model 名称都不拒绝，
//   一律路由到默认后端（qwen-web），并原样回显客户端请求的型号名，
//   避免上游客户端（如请求 gpt-4o 的 OpenWebUI）因型号不在白名单而无谓报错。

'use strict';

// —— 后端定义 ——
// 每个 backend 对应一个具体的执行器；当前只有 cdp（CDP 桥）。
const BACKENDS = {
  cdp: {
    id: 'cdp',
    name: 'Qwen AI Web (CDP Bridge)',
    description:
      '通过 Chrome CDP 桥接已登录的 chat.qwen.ai 网页，复用当前账号的模型/联网状态',
  },
};

// —— 模型路由表 ——
// key = 客户端可能传入的 model 名称（解析时统一转小写比对）。
// value：
//   id        对外暴露的模型 id（与 key 相同，便于 /v1/models 列出）
//   backend   该模型路由到的后端 key（必须是 BACKENDS 中的一项）
//   owned_by  模型归属方（OpenAI 标准字段）
//   description 描述
//   alias_of  若为别名，指向 canonical 模型 id（如 qwen-web）
//   context_window / max_output_tokens  上下文/输出上限（信息性，非强制）
const MODELS = {
  // —— 内置 canonical 模型 ——
  'qwen-web': {
    id: 'qwen-web',
    backend: 'cdp',
    owned_by: 'qwen-cdp-bridge',
    description: '内置：经 CDP 桥接的 Qwen AI 网页版（使用已登录会话）',
    context_window: 131072,
    max_output_tokens: 8192,
  },

  // —— 常用别名：均路由到 qwen-web ——
  'qwen': {
    id: 'qwen',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web',
  },
  'qwen3': {
    id: 'qwen3',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen3）',
  },
  'qwen3-max': {
    id: 'qwen3-max',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen3-Max）',
  },
  'qwen3-coder': {
    id: 'qwen3-coder',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen3-Coder）',
  },
  'qwen3-coder-plus': {
    id: 'qwen3-coder-plus',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen3-Coder-Plus）',
  },
  'qwen3-flash': {
    id: 'qwen3-flash',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen3-Flash）',
  },
  'qwen-max': {
    id: 'qwen-max',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen-Max）',
  },
  'qwen-plus': {
    id: 'qwen-plus',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen-Plus）',
  },
  'qwen-turbo': {
    id: 'qwen-turbo',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen-Turbo）',
  },
  'qwen2.5': {
    id: 'qwen2.5',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen2.5）',
  },
  'qwen2.5-max': {
    id: 'qwen2.5-max',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen2.5-Max）',
  },
  'qwen2.5-coder': {
    id: 'qwen2.5-coder',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen2.5-Coder）',
  },
  'qwen2.5-flash': {
    id: 'qwen2.5-flash',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen2.5-Flash）',
  },
  'qwen-omni': {
    id: 'qwen-omni',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen-Omni 多模态）',
  },
  'qwen-omni-turbo': {
    id: 'qwen-omni-turbo',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen-Omni-Turbo）',
  },
  'qwen-reasoning': {
    id: 'qwen-reasoning',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（深度思考，会尝试打开网页思考开关）',
  },
  'qwen3-reasoning': {
    id: 'qwen3-reasoning',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（Qwen3 深度思考）',
  },
  'qwen-vl': {
    id: 'qwen-vl',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（视觉模型）',
  },
  // —— DashScope 命名空间别名（qwen/xxx）——
  'qwen/qwen-max': {
    id: 'qwen/qwen-max',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（DashScope 命名空间）',
  },
  'qwen/qwen-plus': {
    id: 'qwen/qwen-plus',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（DashScope 命名空间）',
  },
  'qwen/qwen-turbo': {
    id: 'qwen/qwen-turbo',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（DashScope 命名空间）',
  },
  'qwen/qwen3-max': {
    id: 'qwen/qwen3-max',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（DashScope 命名空间）',
  },
  'qwen/qwen2.5-coder': {
    id: 'qwen/qwen2.5-coder',
    backend: 'cdp',
    alias_of: 'qwen-web',
    description: '别名 → qwen-web（DashScope 命名空间）',
  },
};

// 默认模型（请求未指定 model 时使用）
const DEFAULT_MODEL = 'qwen-web';

// 列表/创建时间戳（信息性）
const CREATED = Math.floor(Date.parse('2026-01-01') / 1000);

function normalize(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

// 解析模型名称 → 路由结果。
// 设计原则：路由表只是"配置方便"，不是白名单。任何 model 名称都不拒绝，
// 未知名称一律路由到默认后端（qwen-web），并原样回显请求名。
// 返回 { ok:true, requested, id, backend, owned_by, description, isAlias, isKnown, ... }
function resolveModel(name) {
  const key = normalize(name);
  if (!key) {
    // 未传 model → 使用默认模型（一切以默认后端为准）
    return {
      ok: true,
      requested: DEFAULT_MODEL,
      id: DEFAULT_MODEL,
      backend: 'cdp',
      owned_by: 'qwen-cdp-bridge',
      description: '默认模型（请求未指定 model）',
      isAlias: false,
      isKnown: true,
      context_window: 131072,
      max_output_tokens: 8192,
    };
  }
  const entry = MODELS[key];
  if (entry) {
    // 已知模型/别名 → 解析到 canonical 后端 id，原样回显请求名
    const targetId = entry.alias_of || entry.id;
    return {
      ok: true,
      requested: name, // 客户端实际传入的名称（保留原始大小写）
      id: targetId, // 实际后端使用的 canonical 模型 id
      backend: entry.backend,
      owned_by: entry.owned_by || 'qwen-cdp-bridge',
      description: entry.description || '',
      isAlias: !!entry.alias_of,
      isKnown: true,
      context_window: entry.context_window || null,
      max_output_tokens: entry.max_output_tokens || null,
    };
  }
  // 未知模型：不做白名单限制，统一路由到默认后端（本代理仅此一个后端）。
  // 原样回显请求名，保证上游客户端（如请求 gpt-4o 的 OpenWebUI）不报错；
  // 同时把名称透传给后端控制器，使其仍能按名称关键词（thinking/search 等）尽力切换网页模式。
  return {
    ok: true,
    requested: name,
    id: DEFAULT_MODEL,
    backend: 'cdp',
    owned_by: 'qwen-cdp-bridge',
    description: '',
    isAlias: false,
    isKnown: false,
    context_window: null,
    max_output_tokens: null,
  };
}

// 是否已知模型（含别名）
function isKnownModel(name) {
  return !!MODELS[normalize(name)];
}

// OpenAI 标准模型列表（GET /v1/models）
function listModels() {
  const data = Object.values(MODELS).map((m) => ({
    id: m.id,
    object: 'model',
    created: CREATED,
    owned_by: m.owned_by || 'qwen-cdp-bridge',
    // 非标准但有用的扩展字段
    backend: m.backend,
    description: m.description || '',
    alias_of: m.alias_of || null,
    context_window: m.context_window || null,
    max_output_tokens: m.max_output_tokens || null,
  }));
  return { object: 'list', data };
}

module.exports = {
  BACKENDS,
  MODELS,
  DEFAULT_MODEL,
  resolveModel,
  isKnownModel,
  listModels,
};

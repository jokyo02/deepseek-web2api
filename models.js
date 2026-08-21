// models.js —— 模型路由注册表
//
// 把 OpenAI / DeepSeek 客户端常用的 model 名称统一路由到具体后端。
// 当前唯一内置后端：deepseek-web（经 Chrome CDP 桥接已登录的 chat.deepseek.com 网页）。
//
// 设计目标：
//   1. 内置 canonical 模型 `deepseek-web`，作为本服务对外暴露的"招牌模型"。
//   2. 兼容常见别名（deepseek-chat / deepseek-reasoner / deepseek-coder /
//      deepseek-v3 / deepseek-r1 / deepseek-ai/* 等），全部路由到 deepseek-web。
//   3. 提供 OpenAI 标准的 /v1/models 列表接口。
//   4. 后端可扩展：未来可加入新 backend（如真实 API key 后端）而不必改 api-server。
//
// 重要：本路由表只是"配置方便"，不是白名单限制。
//   本代理本质只有网页版一个后端，因此对任何未知 model 名称都不拒绝，
//   一律路由到默认后端（deepseek-web），并原样回显客户端请求的型号名，
//   避免上游客户端（如请求 gpt-4o 的 OpenWebUI）因型号不在白名单而无谓报错。

'use strict';

// —— 后端定义 ——
// 每个 backend 对应一个具体的执行器；当前只有 cdp（CDP 桥）。
const BACKENDS = {
  cdp: {
    id: 'cdp',
    name: 'DeepSeek Web (CDP Bridge)',
    description:
      '通过 Chrome CDP 桥接已登录的 chat.deepseek.com 网页，复用当前账号的模型/联网状态',
  },
};

// —— 模型路由表 ——
// key = 客户端可能传入的 model 名称（解析时统一转小写比对）。
// value：
//   id        对外暴露的模型 id（与 key 相同，便于 /v1/models 列出）
//   backend   该模型路由到的后端 key（必须是 BACKENDS 中的一项）
//   owned_by  模型归属方（OpenAI 标准字段）
//   description 描述
//   alias_of  若为别名，指向 canonical 模型 id（如 deepseek-web）
//   context_window / max_output_tokens  上下文/输出上限（信息性，非强制）
const MODELS = {
  // —— 内置 canonical 模型 ——
  'deepseek-web': {
    id: 'deepseek-web',
    backend: 'cdp',
    owned_by: 'deepseek-cdp-bridge',
    description: '内置：经 CDP 桥接的 DeepSeek 网页版（使用已登录会话）',
    context_window: 64000,
    max_output_tokens: 8192,
  },

  // —— 常用别名：均路由到 deepseek-web ——
  'deepseek': {
    id: 'deepseek',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web',
  },
  'deepseek-chat': {
    id: 'deepseek-chat',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web（DeepSeek-V3 对话）',
  },
  'deepseek-v3': {
    id: 'deepseek-v3',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web（DeepSeek-V3）',
  },
  'deepseek-coder': {
    id: 'deepseek-coder',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web（代码场景）',
  },
  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web（深度思考 R1）',
  },
  'deepseek-r1': {
    id: 'deepseek-r1',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web（深度思考 R1）',
  },
  'deepseek-ai/deepseek-chat': {
    id: 'deepseek-ai/deepseek-chat',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web',
  },
  'deepseek-ai/deepseek-reasoner': {
    id: 'deepseek-ai/deepseek-reasoner',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web',
  },
  'deepseek-ai/deepseek-coder': {
    id: 'deepseek-ai/deepseek-coder',
    backend: 'cdp',
    alias_of: 'deepseek-web',
    description: '别名 → deepseek-web',
  },
};

// 默认模型（请求未指定 model 时使用）
const DEFAULT_MODEL = 'deepseek-web';

// 列表/创建时间戳（信息性）
const CREATED = Math.floor(Date.parse('2026-01-01') / 1000);

function normalize(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

// 解析模型名称 → 路由结果。
// 设计原则：路由表只是"配置方便"，不是白名单。任何 model 名称都不拒绝，
// 未知名称一律路由到默认后端（deepseek-web），并原样回显请求名。
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
      owned_by: 'deepseek-cdp-bridge',
      description: '默认模型（请求未指定 model）',
      isAlias: false,
      isKnown: true,
      context_window: 64000,
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
      owned_by: entry.owned_by || 'deepseek-cdp-bridge',
      description: entry.description || '',
      isAlias: !!entry.alias_of,
      isKnown: true,
      context_window: entry.context_window || null,
      max_output_tokens: entry.max_output_tokens || null,
    };
  }
  // 未知模型：不做白名单限制，统一路由到默认后端（本代理仅此一个后端）。
  // 原样回显请求名，保证上游客户端（如请求 gpt-4o 的 OpenWebUI）不报错；
  // 同时把名称透传给后端控制器，使其仍能按名称关键词（reasoner/r1/search 等）尽力切换网页模式。
  return {
    ok: true,
    requested: name,
    id: DEFAULT_MODEL,
    backend: 'cdp',
    owned_by: 'deepseek-cdp-bridge',
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
    owned_by: m.owned_by || 'deepseek-cdp-bridge',
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

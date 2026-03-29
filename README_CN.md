# ATAgent

轻量级 Agent 引擎

> 让 AI 控制任意应用的轻量级引擎

---

## 1. 这是什么？

ATAgent 是一个**轻量级 Agent 引擎**，帮助开发者为自己的应用快速添加自然语言控制能力。

**核心理念**：开发者用 JSON 文件定义应用能执行的操作（动作、参数、权限、执行条件），ATAgent 调用 AI 大模型理解用户的自然语言指令，在开发者定义的结构内精准匹配动作、提取参数，并调用对应的业务函数完成执行。开发者负责定义"能做什么"，AI 负责理解"用户想做什么"。

```text
用户说："添加一个明天开会的提醒"

ATAgent 流程：
  1. 将用户输入 + 动作定义结构发送给 AI
  2. AI 理解语义 → 在已定义动作中匹配 add_todo
  3. AI 提取参数 → content = "明天开会"
  4. 执行业务函数 → 完成

用户说了一句模糊的话：

  1. AI 识别出多个候选 → 列出让用户选择
  2. AI 判断意图不明确 → 主动反问
  3. 用户输入 /add_todo 明天开会 → 跳过 AI，直接执行
```

**关键特点**：
- **AI 语义理解**：用户说什么都能理解，覆盖各种自然表达方式；动作定义、参数结构、权限、执行条件由开发者在 JSON 中明确定义，AI 在此结构内工作。
- **纯配置驱动**：所有动作定义在 JSON 文件中，无需编写 AI 相关代码。
- **即插即用**：将 ATAgent 文件夹复制到项目中即可使用，不依赖包管理器。
- **技术栈无关**：可嵌入 Web、桌面、后端等任何环境。
- **UI 完全自由**：AI 交互界面（按钮、对话框等）由开发者自行设计，ATAgent 只提供 API。
- **可视化配置**：内置配置管理界面，支持动作管理与 AI 参数配置，开发阶段开箱即用。
- **支持语音输入**：开发者可自行集成语音识别，将语音转为文本后传入引擎，完整的语音控制体验开箱可用。

---

## 2. 适用场景

| | 场景 | 说明 |
|---|---|---|
| ✅ | 私有部署 / 内网工具 | 可配置私有化部署的大模型（如本地 Ollama） |
| ✅ | 动作集合明确、有限的应用 | 建议动作数 ≤ 500 |
| ✅ | 需要理解复杂自然语言的场景 | 语义理解由 AI 承担，覆盖各种表达方式 |
| ✅ | 多语言输入场景 | AI 天然支持多语言，无需额外适配 |
| ✅ | 需要 workflow 编排的场景 | 支持动作之间的依赖与顺序编排 |
| ✅ | 语音控制场景 | 接入语音识别后转文本即可驱动完整交互流程 |

---

## 3. 整体架构

ATAgent 以**文件夹形式**嵌入到开发者项目中，包含以下部分：

```
atagent/
├── core/                    # 核心逻辑
│   ├── ai.js                # AI 语义理解引擎（调用大模型 API）
│   ├── executor.js          # 动作执行器
│   ├── loader.js            # 加载 JSON 配置
│   ├── conversation.js      # 多轮对话状态管理
│   └── server.js            # 内置 HTTP 服务（可选）
├── ui/                      # 可视化配置界面
│   ├── index.html
│   ├── app.js
│   └── style.css
├── config/                  # 配置存储目录
│   └── actions.json         # 动作定义（核心配置）
├── index.js                 # 主入口
└── README.md
```

- **config/actions.json**：开发者定义所有动作、参数、权限与执行条件的唯一文件。
- **core/ai.js**：封装大模型 API 调用，在动作定义结构内完成语义理解、动作匹配、参数提取。
- **core/**：其余模块负责动作调度、配置加载、多轮对话管理。
- **ui/**：可视化配置界面，用于动作管理和 AI 参数配置。
- **index.js**：导出 ATAgent 类，供项目引入。

---

## 4. AI 配置

ATAgent 需要配置大模型 API 才能工作。支持任意兼容 OpenAI API 格式的服务商，包括私有化部署的模型。

### 4.1 通过可视化界面配置（推荐）

访问 `http://localhost:3000/atagent`，点击右上角「AI 设置」按钮，填写以下参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| API Base URL | 大模型服务地址 | `https://api.openai.com/v1` |
| API Key | 鉴权密钥 | `sk-xxxxxx` |
| Model | 使用的模型名称 | `gpt-4o`、`qwen-max`、`deepseek-chat` |
| Max Tokens | 单次调用最大 Token 数 | `1024` |

配置保存后立即生效，无需重启。

### 4.2 通过代码配置

```javascript
const agent = new ATAgent({
  configPath: './atagent/config/actions.json',
  ai: {
    baseURL: 'https://api.openai.com/v1',
    apiKey: process.env.ATAGENT_API_KEY,
    model: 'gpt-4o',
    maxTokens: 1024
  }
});
```

### 4.3 支持私有化部署

只需将 `baseURL` 替换为本地服务地址，即可接入 Ollama 等本地模型：

```javascript
ai: {
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  model: 'llama3'
}
```

---

## 5. 动作定义格式（JSON）

开发者在 `config/actions.json` 中定义应用的全部动作结构——这是引擎的核心，AI 的理解与执行都在此结构内进行：

```json
{
  "version": "1.0",
  "actions": [
    {
      "name": "add_todo",
      "description": "添加一条待办事项",
      "parameters": [
        {
          "name": "content",
          "type": "string",
          "description": "待办内容",
          "required": true
        },
        {
          "name": "due_date",
          "type": "string",
          "description": "截止日期（可选）",
          "required": false
        }
      ],
      "examples": [
        "添加待办 明天开会",
        "新增任务 写周报",
        "创建一个待办：买牛奶"
      ],
      "messages": {
        "success": "待办「{content}」已添加",
        "confirm": "确认要添加待办「{content}」吗？"
      },
      "permission": "normal",
      "enabled": true,
      "tags": ["生产力"]
    },
    {
      "name": "navigate",
      "description": "跳转到应用内的指定页面",
      "parameters": [
        {
          "name": "page",
          "type": "string",
          "description": "目标页面名称",
          "required": true
        }
      ],
      "examples": [
        "跳转到设置页面",
        "打开个人资料",
        "前往首页"
      ],
      "permission": "normal",
      "enabled": true,
      "tags": ["导航"]
    }
  ]
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `name` | string | ✅ | 动作唯一标识，供代码中映射使用 |
| `description` | string | ✅ | 动作功能描述，AI 根据此字段理解动作用途 |
| `parameters` | array | ❌ | 参数结构定义，AI 从用户输入中提取对应值 |
| `examples` | array | ✅ | 示例语句，帮助 AI 更准确地识别触发场景，越丰富越好 |
| `messages` | object | ❌ | 话术模板，覆盖引擎默认提示语 |
| `permission` | string | ❌ | 权限等级：`normal` / `confirm` / `admin` |
| `enabled` | boolean | ❌ | 是否启用，默认 `true` |
| `tags` | array | ❌ | 分类标签，用于按上下文预筛选候选集，减少单次发给 AI 的动作数量 |
| `cache` | object | ❌ | 显式成功结果缓存配置，默认关闭 |
| `workflow` | object | ❌ | 顺序执行的 workflow 定义，可引用根参数、上下文和前序步骤结果 |

> **关于 `version` 字段**：标识配置文件格式版本，引擎热更新时据此处理进行中的会话，避免状态错乱。

### 5.1 高级字段

**tags 预筛选**

执行时传入 `context.tags`。ATAgent 会先按 action 的 `tags` 缩小候选集；如果没有任何命中，会自动回退到全部动作，避免误过滤。

```javascript
await agent.execute("打开设置", {
  context: {
    tags: ["导航"]
  }
});
```

**显式缓存**

缓存为按 action 显式开启，且只缓存 `success` 响应。

```json
{
  "name": "fetch_summary",
  "cache": {
    "ttlMs": 60000,
    "contextKeys": ["userId"]
  }
}
```

- `ttlMs`：缓存时长，单位毫秒
- `contextKeys`：可选，参与缓存 key 的上下文字段

**顺序 workflow**

workflow action 会按 `steps` 顺序执行。步骤参数支持 `{{...}}` 引用：

- `params.<name>`：根 action 参数
- `context.<name>`：请求上下文
- `steps.<stepId>.data.<field>`：前序步骤结果

```json
{
  "name": "prepare_report",
  "workflow": {
    "steps": [
      {
        "id": "draft",
        "action": "create_draft",
        "params": {
          "title": "{{params.title}}"
        }
      },
      {
        "id": "publish",
        "action": "publish_draft",
        "params": {
          "draftId": "{{steps.draft.data.id}}",
          "note": "publish {{params.title}}"
        }
      }
    ]
  }
}
```

--- 

## 6. AI 语义理解机制

ATAgent 将用户输入和开发者定义的动作结构一起发送给大模型，由 AI 在此结构内完成：

1. **意图识别**：理解用户想做什么，在已定义的动作中找到最合适的匹配。
2. **参数提取**：按照参数结构定义，从自然语言中提取对应值。
3. **歧义判断**：判断是否存在多个合理候选，或意图是否明确。
4. **追问生成**：当必需参数缺失时，生成自然的追问语句。

### 6.1 三层处理逻辑

```text
用户输入 + 动作定义结构 → AI 分析
    │
    ├─ 高置信度命中 ──────────────────→ 直接执行
    │
    ├─ 存在多个候选 ──────────────────→ 列出候选，让用户选择
    │    "您是想：① 添加待办  ② 添加日历事件  ③ 发送消息？"
    │
    ├─ 意图不明确 ────────────────────→ AI 主动反问
    │    "我没太明白您想做什么，能说得更具体一点吗？"
    │
    └─ 用户直接输入精确指令 ──────────→ 跳过 AI，直接执行
         /add_todo 明天开会
```

### 6.2 用户精确接管

任何时候用户都可以使用 `/动作名 参数` 格式直接指定动作，绕过 AI 匹配：

```text
/add_todo 明天下午三点开产品评审会
/navigate settings
/delete_todo id=123
```

引擎在连续两次澄清未能解决问题后，自动提示用户可以使用这种方式。

### 6.3 澄清轮次限制

最多进行 2 轮澄清追问，超过后自动提示：

```text
"您可以直接输入 /动作名 来精确操作，例如 /add_todo 明天开会"
```

---

## 7. 集成方式（开发者视角）

### 7.1 将 ATAgent 文件夹放入项目

将 `atagent` 文件夹复制到项目根目录。

### 7.2 初始化并注册处理器

```javascript
const ATAgent = require('./atagent');

const agent = new ATAgent({
  configPath: './atagent/config/actions.json',
  ai: {
    baseURL: 'https://api.openai.com/v1',
    apiKey: process.env.ATAGENT_API_KEY,
    model: 'gpt-4o'
  },
  maxClarifyRounds: 2,
  maxCandidates: 3
});

agent.registerHandlers({
  add_todo: async (params) => {
    await yourApp.todo.add(params.content, params.due_date);
    return { message: `待办「${params.content}」已添加` };
  },
  navigate: async (params) => {
    yourApp.router.push(`/${params.page}`);
    return { message: `已跳转到 ${params.page}` };
  }
});

// Web 应用：挂载中间件
app.use('/atagent', agent.middleware());

// 桌面 / 后端：启动内置服务
agent.startServer(3001);
```

### 7.3 前端调用

```javascript
const response = await fetch('/atagent/api/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input: "添加待办 明天开会",
    context: { route: "/todos", userId: "123" },
    sessionId: "user-123-session"
  })
});

const result = await response.json();

switch (result.status) {
  case 'success':
    showToast(result.message);
    break;
  case 'needs_more_info':
    showPrompt(result.question);
    break;
  case 'multiple_candidates':
    showCandidateSelector(result.candidates);
    break;
  case 'requires_confirmation':
    showConfirmDialog(result.message, result.confirmToken);
    break;
  case 'unresolved':
    showToast(result.message);
    break;
}
```

**响应格式**：

```json
// 成功
{
  "status": "success",
  "message": "待办「明天开会」已添加",
  "data": { "todoId": 456 }
}

// 需要补充信息
{
  "status": "needs_more_info",
  "action": "add_todo",
  "missing_params": ["content"],
  "question": "请问待办的内容是什么？",
  "clarifyRound": 1,
  "sessionId": "user-123-session"
}

// 存在歧义
{
  "status": "multiple_candidates",
  "candidates": [
    { "name": "add_todo",  "description": "添加待办事项",  "score": 0.92 },
    { "name": "add_event", "description": "添加日历事件",  "score": 0.85 }
  ],
  "message": "您是想：① 添加待办事项  ② 添加日历事件？"
}

// 超过澄清轮次，无法解决
{
  "status": "unresolved",
  "message": "我还是没能理解您的意图，您可以直接输入 /动作名 来精确操作，例如 /add_todo 明天开会"
}
```

### 7.4 多轮对话

会话状态由 `sessionId` 标识，引擎默认内存存储。

如果你想要一个零依赖、可直接落盘的轻量方案，可以使用内置 JSON 文件存储：

```javascript
const ATAgent = require('./atagent');

const agent = new ATAgent({
  sessionStore: new ATAgent.JsonFileStateStore('./data/sessions.json'),
  confirmationStore: new ATAgent.JsonFileStateStore('./data/confirmations.json'),
  cacheStore: new ATAgent.JsonFileCacheStore('./data/cache.json')
});
```

如果你已经有自己的 Redis、MySQL、PostgreSQL 或业务数据库，也可以直接注入自定义 store。引擎不强绑具体存储，只约定最小接口：

```javascript
const stateStore = {
  async get(key) {},
  async set(key, value) {},
  async delete(key) {}
};

const cacheStore = {
  async get(key) {},
  async set(key, value, ttlMs) {},
  async delete(key) {}
};

const agent = new ATAgent({
  sessionStore: stateStore,
  confirmationStore: stateStore,
  cacheStore
});
```

- `sessionStore` / `confirmationStore`：用于多轮澄清与确认令牌持久化
- `cacheStore`：用于 action 成功结果缓存
- 默认仍是内存实现，只有显式传入时才会改为 JSON / Redis / 数据库

```text
用户: "添加待办"
AI:   "请问待办内容是什么？"（needs_more_info，clarifyRound: 1）
用户: "明天开会"
AI:   执行添加，返回成功
```

### 7.5 非 Web 环境直接调用

```javascript
const result = await agent.execute('添加待办', {
  context: { userId: 'cli-user' },
  sessionId: 'cli-session'
});

if (result.status === 'needs_more_info') {
  const userInput = await askUser(result.question);
  const finalResult = await agent.continue(userInput, result.sessionId);
  console.log(finalResult.message);
}
```

---

## 8. 提示语与话术

引擎内置合理的默认提示语，开发者可按需覆盖：

**全局覆盖（初始化时）**：
```javascript
const agent = new ATAgent({
  messages: {
    unresolved:      '我还是没能理解，您可以直接输入 /动作名 来精确操作',
    askClarify:      '我没太明白，能说得更具体吗？',
    candidatePrompt: '您是想执行以下哪个操作？'
  }
});
```

**单动作覆盖（actions.json 中的 `messages` 字段）**：
```json
"messages": {
  "success": "待办「{content}」已添加",
  "confirm": "确认要添加待办「{content}」吗？"
}
```

---

## 9. 权限与确认

| 等级 | 行为 | 典型场景 |
|------|------|----------|
| `normal` | 直接执行 | 查询、浏览、创建 |
| `confirm` | 执行前需用户确认 | 删除、发送、支付 |
| `admin` | 需要管理员权限 | 系统设置、权限变更 |

---

## 10. 上下文传递与动作前置检查

`canExecute` 是保护生产安全的关键机制，建议对所有涉及状态变更的动作加以使用：

```javascript
agent.registerHandlers({
  delete_todo: {
    handler: async (params) => { /* 删除逻辑 */ },
    canExecute: ({ context }) => {
      if (!context.selectedTodoId) {
        return {
          allowed: false,
          reason: '请先选择一个待办事项',
          suggestedAction: { label: '选择待办', action: 'select-todo' }
        };
      }
      return { allowed: true };
    }
  }
});
```

---

## 11. 可视化配置界面

ATAgent 内置 Web 配置界面（`ui/` 目录），访问 `http://localhost:3000/atagent` 即可使用。

**功能**：
- **动作管理**：查看、添加、编辑、删除动作，自动读写 `config/actions.json`。
- **AI 设置**：配置 API Base URL、API Key、模型名称等参数，保存后立即生效。
- **动作测试**：输入自然语言，实时查看 AI 匹配结果和执行效果。
- **配置导出/导入**：支持 JSON 文件的导入导出，便于团队协作和备份。

> 生产环境应禁用该界面或通过鉴权保护，避免暴露 API Key 等敏感配置。

---

## 12. 配置版本管理

`actions.json` 顶层 `version` 字段用于管理配置变更：

- **热更新**：修改配置后无需重启，引擎自动重新加载。
- **会话保护**：热更新时，对进行中的多轮对话会话进行兼容性处理。
- **不兼容变更**（如删除动作、修改必需参数）自动标记为新版本，旧会话收到友好提示后关闭。

---

## 13. 性能指标

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 端到端响应时间 | < 2s | 含 AI API 调用，网络条件良好时 |
| 本地处理耗时 | < 10ms | 不含 AI API 的本地逻辑处理 |
| 内存占用 | < 20MB | 包含所有动作配置和运行时状态 |
| 动作数量上限 | 500 个 | 超过后建议按 `tags` 分类路由，减少单次传给 AI 的动作数量 |

**性能优化建议**：
- 按 `tags` 预筛选候选集，减少发送给 AI 的动作数量，降低延迟和 Token 消耗。
- 对高频动作设置本地缓存，相同输入直接返回缓存结果。
- 选用响应速度较快的模型（如 GPT-4o mini、Qwen-Turbo）平衡效果与延迟。

---

## 14. 快速开始

**14.1 复制文件夹**：将 ATAgent 文件夹复制到你的项目中。

**14.2 配置 AI**：访问 `/atagent` 界面，点击「AI 设置」填写 API 参数；或在代码初始化时传入 `ai` 配置项。

**14.3 编写动作定义**：编辑 `atagent/config/actions.json`，定义应用支持的动作结构。`examples` 越丰富，AI 匹配越准确。

**14.4 注册处理器**：在项目入口引入 ATAgent，注册每个动作对应的业务函数。

**14.5 设计 AI 交互界面**：在应用中添加 AI 按钮或对话框，调用 `/atagent/api/execute` 接口，处理五种响应状态即可。

**14.6 启动项目**：启动应用，ATAgent 自动初始化并可用。

---

## 15. 总结

ATAgent 通过 **一个文件夹 + 一个 JSON 配置**，让任意应用快速拥有自然语言控制能力。核心设计原则：

- **开发者定义结构，AI 理解语义**：动作、参数、权限、执行条件由开发者明确定义；AI 在此结构内理解用户意图、提取参数，两者职责清晰。
- **遇到不确定，主动澄清**：而不是静默失败，用户始终知道发生了什么。
- **用户随时可以接管**：`/动作名 参数` 精确模式是所有场景下的兜底。
- **引擎只提供 API，UI 和话术由开发者掌控**：内置合理默认值，需要时可全量覆盖。
- **安全优先**：权限分级 + `canExecute` 前置检查，保护生产环境中的敏感操作。

---

**许可证**：MIT © ATAgent Contributors

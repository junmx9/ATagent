"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ATAgent = require("../index");
const { MemoryStateStore } = require("../core/conversation");
const { JsonFileStateStore, JsonFileCacheStore } = require("../core/json_store");

function createTempProject(actionsConfig, aiConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atagent-"));
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "actions.json"),
    `${JSON.stringify(actionsConfig, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(configDir, "ai.json"),
    `${JSON.stringify(
      {
        baseURL: "",
        apiKey: "",
        model: "",
        maxTokens: 1024,
        temperature: 0.1,
        systemPrompt: "",
        timeoutMs: 10000,
        maxRetries: 1,
        allowHeuristicFallback: false,
        ...aiConfig
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return root;
}

function createAgent(t, actionsConfig, options = {}) {
  const root = createTempProject(actionsConfig, options.aiConfig);
  const agent = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    ...options
  });
  t.after(() => agent.close());
  return { agent, root };
}

test("supports direct command execution", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "add_todo",
        description: "添加待办",
        parameters: [{ name: "content", type: "string", required: true }],
        examples: ["添加待办 明天开会"]
      }
    ]
  });

  let received = null;
  agent.registerHandlers({
    add_todo: async (params) => {
      received = params;
      return { message: `created:${params.content}` };
    }
  });

  const result = await agent.execute("/add_todo finish-report");
  assert.equal(result.status, "success");
  assert.equal(result.message, "created:finish-report");
  assert.deepEqual(received, { content: "finish-report" });
});

test("asks for clarification and can continue the session", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "add_todo",
        description: "添加待办",
        parameters: [{ name: "content", type: "string", required: true }],
        examples: ["添加待办 明天开会"]
      }
    ]
  });

  agent.registerHandlers({
    add_todo: async (params) => ({ message: `ok:${params.content}` })
  });

  const first = await agent.execute("添加待办");
  assert.equal(first.status, "needs_more_info");
  assert.ok(first.sessionId);

  const second = await agent.continue("明天开会", first.sessionId);
  assert.equal(second.status, "success");
  assert.equal(second.message, "ok:明天开会");
});

test("requires confirmation for confirm actions", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "delete_todo",
        description: "删除待办",
        permission: "confirm",
        parameters: [{ name: "id", type: "string", required: true }],
        examples: ["删除待办 id=1"]
      }
    ]
  });

  let deletedId = null;
  agent.registerHandlers({
    delete_todo: async (params) => {
      deletedId = params.id;
      return { message: `deleted:${params.id}` };
    }
  });

  const first = await agent.execute("/delete_todo id=42");
  assert.equal(first.status, "requires_confirmation");
  assert.ok(first.confirmToken);

  const second = await agent.confirm(first.confirmToken);
  assert.equal(second.status, "success");
  assert.equal(second.message, "deleted:42");
  assert.equal(deletedId, "42");
});

test("blocks execution when canExecute rejects", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "delete_todo",
        description: "删除待办",
        parameters: [{ name: "id", type: "string", required: true }],
        examples: ["删除待办 id=1"]
      }
    ]
  });

  agent.registerHandlers({
    delete_todo: {
      handler: async () => ({ message: "should not happen" }),
      canExecute: () => ({
        allowed: false,
        reason: "请先选择一个待办事项"
      })
    }
  });

  const result = await agent.execute("/delete_todo id=42");
  assert.equal(result.status, "blocked");
  assert.equal(result.message, "请先选择一个待办事项");
});

test("invalidates clarification session after config version changes", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "add_todo",
        description: "添加待办",
        parameters: [{ name: "content", type: "string", required: true }],
        examples: ["添加待办 明天开会"]
      }
    ]
  });

  agent.registerHandlers({
    add_todo: async (params) => ({ message: `ok:${params.content}` })
  });

  const first = await agent.execute("添加待办");
  assert.equal(first.status, "needs_more_info");

  agent.saveActions({
    version: "2.0.0",
    actions: [
      {
        name: "add_todo",
        description: "添加待办",
        parameters: [{ name: "content", type: "string", required: true }],
        examples: ["添加待办 明天开会"]
      }
    ]
  });

  const second = await agent.continue("明天开会", first.sessionId);
  assert.equal(second.status, "unresolved");
  assert.match(second.message, /配置已更新/);
});

test("re-enters full matching after generic clarification", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "add_todo",
        description: "添加待办",
        parameters: [{ name: "content", type: "string", required: true }],
        examples: ["添加待办 明天开会"]
      }
    ]
  });

  agent.registerHandlers({
    add_todo: async (params) => ({ message: `ok:${params.content}` })
  });

  const first = await agent.execute("帮我处理一下");
  assert.equal(first.status, "needs_more_info");

  const second = await agent.continue("添加待办 明天开会", first.sessionId);
  assert.equal(second.status, "success");
  assert.equal(second.message, "ok:明天开会");
});

test("filters candidate actions by context tags and falls back to all actions", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "navigate",
        description: "打开页面",
        parameters: [{ name: "page", type: "string", required: true }],
        examples: ["打开页面 设置页面"],
        tags: ["导航"]
      },
      {
        name: "add_todo",
        description: "添加待办",
        parameters: [{ name: "content", type: "string", required: true }],
        examples: ["添加待办 写周报"],
        tags: ["生产力"]
      }
    ]
  });

  agent.registerHandlers({
    navigate: async (params) => ({ message: `nav:${params.page}` }),
    add_todo: async (params) => ({ message: `todo:${params.content}` })
  });

  const filtered = await agent.execute("打开页面 设置页面", {
    context: { tags: ["导航"] }
  });
  assert.equal(filtered.status, "success");
  assert.equal(filtered.action, "navigate");
  assert.equal(filtered.message, "nav:设置页面");

  const fallback = await agent.execute("打开页面 设置页面", {
    context: { tags: ["不存在"] }
  });
  assert.equal(fallback.status, "success");
  assert.equal(fallback.action, "navigate");
  assert.equal(fallback.message, "nav:设置页面");
});

test("direct command bypasses tag prefilter", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "navigate",
        description: "打开页面",
        parameters: [{ name: "page", type: "string", required: true }],
        examples: ["打开设置页面"],
        tags: ["导航"]
      }
    ]
  });

  agent.registerHandlers({
    navigate: async (params) => ({ message: `nav:${params.page}` })
  });

  const result = await agent.execute("/navigate settings", {
    context: { tags: ["生产力"] }
  });
  assert.equal(result.status, "success");
  assert.equal(result.message, "nav:settings");
});

test("returns cached success result for cache-enabled action", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "fetch_summary",
        description: "获取摘要",
        parameters: [{ name: "topic", type: "string", required: true }],
        examples: ["获取摘要 市场周报"],
        cache: {
          ttlMs: 60_000,
          contextKeys: ["userId"]
        }
      }
    ]
  });

  let calls = 0;
  agent.registerHandlers({
    fetch_summary: async (params) => {
      calls += 1;
      return {
        message: `summary:${calls}:${params.topic}`,
        data: { calls }
      };
    }
  });

  const first = await agent.execute("/fetch_summary weekly", {
    context: { userId: "u1" }
  });
  const second = await agent.execute("/fetch_summary weekly", {
    context: { userId: "u1" }
  });
  const third = await agent.execute("/fetch_summary weekly", {
    context: { userId: "u2" }
  });

  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.equal(first.message, "summary:1:weekly");
  assert.equal(second.message, "summary:1:weekly");
  assert.equal(third.message, "summary:2:weekly");
  assert.equal(calls, 2);
});

test("executes workflow steps sequentially and passes previous step data", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "prepare_report",
        description: "准备报告",
        parameters: [{ name: "title", type: "string", required: true }],
        examples: ["准备报告 周报"],
        workflow: {
          steps: [
            {
              id: "draft",
              action: "create_draft",
              params: {
                title: "{{params.title}}"
              }
            },
            {
              id: "publish",
              action: "publish_draft",
              params: {
                draftId: "{{steps.draft.data.id}}",
                note: "publish {{params.title}}"
              }
            }
          ]
        }
      },
      {
        name: "create_draft",
        description: "创建草稿",
        parameters: [{ name: "title", type: "string", required: true }],
        examples: ["创建草稿 周报"]
      },
      {
        name: "publish_draft",
        description: "发布草稿",
        parameters: [
          { name: "draftId", type: "string", required: true },
          { name: "note", type: "string", required: true }
        ],
        examples: ["发布草稿 123"]
      }
    ]
  });

  const calls = [];
  agent.registerHandlers({
    create_draft: async (params) => {
      calls.push({ action: "create_draft", params });
      return {
        message: `draft:${params.title}`,
        data: { id: "draft-001" }
      };
    },
    publish_draft: async (params, context) => {
      calls.push({ action: "publish_draft", params, workflow: context.workflow });
      return {
        message: `published:${params.draftId}`,
        data: { published: true, note: params.note }
      };
    }
  });

  const result = await agent.execute("/prepare_report weekly-report");
  assert.equal(result.status, "success");
  assert.equal(result.action, "prepare_report");
  assert.equal(result.message, "published:draft-001");
  assert.deepEqual(calls[0], {
    action: "create_draft",
    params: { title: "weekly-report" }
  });
  assert.deepEqual(calls[1].params, {
    draftId: "draft-001",
    note: "publish weekly-report"
  });
  assert.equal(calls[1].workflow.action, "prepare_report");
  assert.equal(calls[1].workflow.currentStepId, "publish");
  assert.equal(calls[1].workflow.steps.draft.data.id, "draft-001");
  assert.equal(result.data.steps.draft.data.id, "draft-001");
  assert.equal(result.data.steps.publish.data.published, true);
});

test("returns structured AI errors instead of silently falling back", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new Error("timed out");
    error.name = "AbortError";
    throw error;
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const { agent } = createAgent(
    t,
    {
      version: "1.0.0",
      actions: [
        {
          name: "add_todo",
          description: "添加待办",
          parameters: [{ name: "content", type: "string", required: true }],
          examples: ["添加待办 明天开会"]
        }
      ]
    },
    {
      aiConfig: {
        baseURL: "https://example.com/v1",
        model: "demo-model",
        timeoutMs: 50,
        maxRetries: 0,
        allowHeuristicFallback: false
      }
    }
  );

  const result = await agent.execute("添加待办 明天开会");
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "ai_timeout");
  assert.equal(result.error.retryable, true);
});

test("supports shared session stores across agent instances", async (t) => {
  const root = createTempProject({
    version: "1.0.0",
    actions: [
      {
        name: "add_todo",
        description: "添加待办",
        parameters: [{ name: "content", type: "string", required: true }],
        examples: ["添加待办 明天开会"]
      }
    ]
  });

  const sessionStore = new MemoryStateStore();
  const confirmationStore = new MemoryStateStore();

  const agent1 = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    sessionStore,
    confirmationStore
  });
  const agent2 = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    sessionStore,
    confirmationStore
  });
  t.after(async () => {
    await agent1.close();
    await agent2.close();
  });

  agent1.registerHandlers({
    add_todo: async (params) => ({ message: `ok:${params.content}` })
  });
  agent2.registerHandlers({
    add_todo: async (params) => ({ message: `ok:${params.content}` })
  });

  const first = await agent1.execute("添加待办");
  assert.equal(first.status, "needs_more_info");

  const second = await agent2.continue("明天开会", first.sessionId);
  assert.equal(second.status, "success");
  assert.equal(second.message, "ok:明天开会");
});

test("supports json file session stores across agent instances", async (t) => {
  const root = createTempProject({
    version: "1.0.0",
    actions: [
      {
        name: "add_todo",
        description: "添加待办",
        parameters: [{ name: "content", type: "string", required: true }],
        examples: ["添加待办 明天开会"]
      }
    ]
  });

  const storeDir = path.join(root, "data");
  const sessionFile = path.join(storeDir, "sessions.json");
  const confirmationFile = path.join(storeDir, "confirmations.json");

  const agent1 = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    sessionStore: new JsonFileStateStore(sessionFile),
    confirmationStore: new JsonFileStateStore(confirmationFile)
  });
  const agent2 = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    sessionStore: new JsonFileStateStore(sessionFile),
    confirmationStore: new JsonFileStateStore(confirmationFile)
  });
  t.after(async () => {
    await agent1.close();
    await agent2.close();
  });

  agent1.registerHandlers({
    add_todo: async (params) => ({ message: `ok:${params.content}` })
  });
  agent2.registerHandlers({
    add_todo: async (params) => ({ message: `ok:${params.content}` })
  });

  const first = await agent1.execute("添加待办");
  assert.equal(first.status, "needs_more_info");

  const second = await agent2.continue("明天开会", first.sessionId);
  assert.equal(second.status, "success");
  assert.equal(second.message, "ok:明天开会");
});

test("supports json file confirmation stores across agent instances", async (t) => {
  const root = createTempProject({
    version: "1.0.0",
    actions: [
      {
        name: "delete_todo",
        description: "删除待办",
        permission: "confirm",
        parameters: [{ name: "id", type: "string", required: true }],
        examples: ["删除待办 id=1"]
      }
    ]
  });

  const storeDir = path.join(root, "data");
  const sessionFile = path.join(storeDir, "sessions.json");
  const confirmationFile = path.join(storeDir, "confirmations.json");

  const agent1 = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    sessionStore: new JsonFileStateStore(sessionFile),
    confirmationStore: new JsonFileStateStore(confirmationFile)
  });
  const agent2 = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    sessionStore: new JsonFileStateStore(sessionFile),
    confirmationStore: new JsonFileStateStore(confirmationFile)
  });
  t.after(async () => {
    await agent1.close();
    await agent2.close();
  });

  let deletedId = null;
  agent1.registerHandlers({
    delete_todo: async (params) => {
      deletedId = params.id;
      return { message: `deleted:${params.id}` };
    }
  });
  agent2.registerHandlers({
    delete_todo: async (params) => {
      deletedId = params.id;
      return { message: `deleted:${params.id}` };
    }
  });

  const first = await agent1.execute("/delete_todo id=42");
  assert.equal(first.status, "requires_confirmation");

  const second = await agent2.confirm(first.confirmToken);
  assert.equal(second.status, "success");
  assert.equal(second.message, "deleted:42");
  assert.equal(deletedId, "42");
});

test("supports json file cache persistence across agent instances", async (t) => {
  const root = createTempProject({
    version: "1.0.0",
    actions: [
      {
        name: "fetch_summary",
        description: "获取摘要",
        parameters: [{ name: "topic", type: "string", required: true }],
        examples: ["获取摘要 周报"],
        cache: {
          enabled: true,
          ttlMs: 60_000,
          contextKeys: ["userId"]
        }
      }
    ]
  });

  const cacheFile = path.join(root, "data", "cache.json");

  const agent1 = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    cacheStore: new JsonFileCacheStore(cacheFile)
  });
  const agent2 = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    cacheStore: new JsonFileCacheStore(cacheFile)
  });
  t.after(async () => {
    await agent1.close();
    await agent2.close();
  });

  let agent1Calls = 0;
  let agent2Calls = 0;
  agent1.registerHandlers({
    fetch_summary: async (params) => {
      agent1Calls += 1;
      return {
        message: `summary:${agent1Calls}:${params.topic}`,
        data: { calls: agent1Calls }
      };
    }
  });
  agent2.registerHandlers({
    fetch_summary: async () => {
      agent2Calls += 1;
      return {
        message: "summary:agent2",
        data: { calls: agent2Calls }
      };
    }
  });

  const first = await agent1.execute("/fetch_summary weekly", {
    context: { userId: "u1" }
  });
  const second = await agent2.execute("/fetch_summary weekly", {
    context: { userId: "u1" }
  });

  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.equal(first.message, "summary:1:weekly");
  assert.equal(second.message, "summary:1:weekly");
  assert.equal(agent1Calls, 1);
  assert.equal(agent2Calls, 0);
});

test("expires json file cache entries after ttl", async () => {
  const cacheFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "atagent-cache-")),
    "cache.json"
  );
  const store = new JsonFileCacheStore(cacheFile);

  await store.set("demo", { ok: true }, 100);
  assert.deepEqual(await store.get("demo"), { ok: true });

  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(await store.get("demo"), null);
});

test("runs workflow compensation in reverse order on failure", async (t) => {
  const { agent } = createAgent(t, {
    version: "1.0.0",
    actions: [
      {
        name: "publish_report",
        description: "发布报告",
        parameters: [{ name: "title", type: "string", required: true }],
        examples: ["发布报告 周报"],
        workflow: {
          steps: [
            {
              id: "draft",
              action: "create_draft",
              params: {
                title: "{{params.title}}"
              },
              compensate: {
                action: "delete_draft",
                params: {
                  draftId: "{{steps.draft.data.id}}"
                }
              }
            },
            {
              id: "publish",
              action: "send_report",
              params: {
                draftId: "{{steps.draft.data.id}}"
              }
            }
          ]
        }
      },
      {
        name: "create_draft",
        description: "创建草稿",
        parameters: [{ name: "title", type: "string", required: true }],
        examples: ["创建草稿 周报"]
      },
      {
        name: "delete_draft",
        description: "删除草稿",
        parameters: [{ name: "draftId", type: "string", required: true }],
        examples: ["删除草稿 draft-001"]
      },
      {
        name: "send_report",
        description: "发送报告",
        parameters: [{ name: "draftId", type: "string", required: true }],
        examples: ["发送报告 draft-001"]
      }
    ]
  });

  const calls = [];
  agent.registerHandlers({
    create_draft: async (params) => {
      calls.push(`create:${params.title}`);
      return {
        message: "draft created",
        data: { id: "draft-001" }
      };
    },
    delete_draft: async (params) => {
      calls.push(`delete:${params.draftId}`);
      return {
        message: "draft deleted"
      };
    },
    send_report: async () => {
      calls.push("send");
      throw new Error("send failed");
    }
  });

  const result = await agent.execute("/publish_report weekly");
  assert.equal(result.status, "error");
  assert.equal(result.failedStep, "publish");
  assert.deepEqual(calls, ["create:weekly", "send", "delete:draft-001"]);
  assert.equal(result.compensation.length, 1);
  assert.equal(result.compensation[0].status, "success");
  assert.equal(result.compensation[0].action, "delete_draft");
});

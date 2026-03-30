"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ATAgent = require("../index");

function createTempProject(actionsConfig, aiConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atagent-plan-"));
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

test("executes goal mode and replans next step from previous result", async (t) => {
  const calls = [];
  const { agent } = createAgent(
    t,
    {
      version: "1.0.0",
      actions: [
        {
          name: "lookup_contact",
          description: "查询联系人",
          parameters: [{ name: "name", type: "string", required: true }],
          examples: ["查询联系人 张三"]
        },
        {
          name: "send_email",
          description: "发送邮件",
          parameters: [{ name: "address", type: "string", required: true }],
          examples: ["发送邮件 a@example.com"]
        },
        {
          name: "send_sms",
          description: "发送短信",
          parameters: [{ name: "phone", type: "string", required: true }],
          examples: ["发送短信 13800000000"]
        }
      ]
    },
    {
      planEngine: {
        async createPlan() {
          return {
            type: "plan",
            goal: "联系张三",
            steps: [
              {
                id: "lookup",
                action: "lookup_contact",
                params: { name: "张三" }
              }
            ]
          };
        },
        async decideNext({ lastOutcome }) {
          if (lastOutcome.step.id === "lookup") {
            return {
              type: "continue",
              steps: [
                {
                  id: "notify",
                  action: "send_email",
                  params: { address: lastOutcome.result.data.email }
                }
              ]
            };
          }

          return {
            type: "complete",
            message: "联系已完成"
          };
        }
      }
    }
  );

  agent.registerHandlers({
    lookup_contact: async (params) => {
      calls.push({ action: "lookup_contact", params });
      return {
        message: "lookup:ok",
        data: { email: "zhangsan@example.com" }
      };
    },
    send_email: async (params) => {
      calls.push({ action: "send_email", params });
      return {
        message: `email:${params.address}`
      };
    },
    send_sms: async (params) => {
      calls.push({ action: "send_sms", params });
      return {
        message: `sms:${params.phone}`
      };
    }
  });

  const result = await agent.execute("联系张三", { mode: "goal" });
  assert.equal(result.status, "success");
  assert.equal(result.mode, "goal");
  assert.equal(result.message, "联系已完成");
  assert.deepEqual(calls, [
    { action: "lookup_contact", params: { name: "张三" } },
    { action: "send_email", params: { address: "zhangsan@example.com" } }
  ]);
  assert.equal(result.data.completed_steps.length, 2);
  assert.equal(result.data.completed_steps[1].step.action, "send_email");
});

test("pauses goal mode for confirmation and resumes remaining steps", async (t) => {
  const calls = [];
  const { agent } = createAgent(
    t,
    {
      version: "1.0.0",
      actions: [
        {
          name: "delete_todo",
          description: "删除待办",
          permission: "confirm",
          parameters: [{ name: "id", type: "string", required: true }],
          examples: ["删除待办 id=1"]
        },
        {
          name: "write_audit_log",
          description: "记录审计日志",
          parameters: [{ name: "content", type: "string", required: true }],
          examples: ["记录审计日志 删除待办"]
        }
      ]
    },
    {
      planEngine: {
        async createPlan() {
          return {
            type: "plan",
            goal: "删除待办并记录审计",
            steps: [
              {
                id: "delete",
                action: "delete_todo",
                params: { id: "42" }
              }
            ]
          };
        },
        async decideNext({ lastOutcome }) {
          if (lastOutcome.step.id === "delete") {
            return {
              type: "continue",
              steps: [
                {
                  id: "audit",
                  action: "write_audit_log",
                  params: { content: `deleted:${lastOutcome.result.data.id}` }
                }
              ]
            };
          }

          return { type: "complete" };
        }
      }
    }
  );

  agent.registerHandlers({
    delete_todo: async (params) => {
      calls.push({ action: "delete_todo", params });
      return {
        message: `deleted:${params.id}`,
        data: { id: params.id }
      };
    },
    write_audit_log: async (params) => {
      calls.push({ action: "write_audit_log", params });
      return {
        message: `audit:${params.content}`
      };
    }
  });

  const first = await agent.execute("删除待办并记录审计", { mode: "goal" });
  assert.equal(first.status, "requires_confirmation");
  assert.equal(first.mode, "goal");
  assert.ok(first.confirmToken);
  assert.ok(first.planId);

  const second = await agent.confirm(first.confirmToken);
  assert.equal(second.status, "success");
  assert.equal(second.mode, "goal");
  assert.equal(second.data.completed_steps.length, 2);
  assert.deepEqual(calls, [
    { action: "delete_todo", params: { id: "42" } },
    { action: "write_audit_log", params: { content: "deleted:42" } }
  ]);
});

test("pauses goal mode for clarification and resumes after continue", async (t) => {
  const calls = [];
  const { agent } = createAgent(
    t,
    {
      version: "1.0.0",
      actions: [
        {
          name: "create_ticket",
          description: "创建工单",
          parameters: [{ name: "title", type: "string", required: true }],
          examples: ["创建工单 服务器故障"]
        }
      ]
    },
    {
      planEngine: {
        async createPlan() {
          return {
            type: "plan",
            goal: "创建工单",
            steps: [
              {
                id: "ticket",
                action: "create_ticket",
                params: {}
              }
            ]
          };
        },
        async decideNext() {
          return { type: "complete", message: "工单已创建" };
        }
      }
    }
  );

  agent.registerHandlers({
    create_ticket: async (params) => {
      calls.push(params);
      return {
        message: `ticket:${params.title}`
      };
    }
  });

  const first = await agent.execute("创建工单", { mode: "goal" });
  assert.equal(first.status, "needs_more_info");
  assert.equal(first.mode, "goal");
  assert.ok(first.sessionId);
  assert.ok(first.planId);

  const second = await agent.continue("服务器故障", first.sessionId);
  assert.equal(second.status, "success");
  assert.equal(second.mode, "goal");
  assert.equal(second.message, "工单已创建");
  assert.deepEqual(calls, [{ title: "服务器故障" }]);
  assert.equal(second.data.completed_steps.length, 1);
});

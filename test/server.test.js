"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ATAgent = require("../index");

function createTempProject(actionsConfig, aiConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atagent-server-"));
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

async function startAgentServer(t, { actionsConfig, agentOptions = {}, serverOptions = {} }) {
  const root = createTempProject(actionsConfig, agentOptions.aiConfig);
  const agent = new ATAgent({
    configPath: path.join(root, "config", "actions.json"),
    aiConfigPath: path.join(root, "config", "ai.json"),
    watchConfig: false,
    ...agentOptions
  });
  const server = agent.startServer(0, {
    host: "127.0.0.1",
    ...serverOptions
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  t.after(async () => {
    await agent.close();
  });
  return {
    agent,
    baseUrl: `http://127.0.0.1:${port}`
  };
}

test("api rejects unauthorized config access", async (t) => {
  const { baseUrl } = await startAgentServer(t, {
    actionsConfig: {
      version: "1.0.0",
      actions: []
    },
    agentOptions: {
      server: {
        security: {
          auth: {
            token: "secret-token"
          }
        }
      }
    }
  });

  const unauthorized = await fetch(`${baseUrl}/atagent/api/actions`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/atagent/api/actions`, {
    headers: {
      "X-ATAgent-Token": "secret-token"
    }
  });
  assert.equal(authorized.status, 200);
});

test("api rate limit returns 429", async (t) => {
  const { agent, baseUrl } = await startAgentServer(t, {
    actionsConfig: {
      version: "1.0.0",
      actions: [
        {
          name: "echo",
          description: "回显",
          parameters: [{ name: "text", type: "string", required: true }],
          examples: ["回显 hello"]
        }
      ]
    },
    agentOptions: {
      server: {
        security: {
          rateLimit: {
            windowMs: 60_000,
            max: 1
          }
        }
      }
    }
  });

  agent.registerHandlers({
    echo: async (params) => ({ message: params.text })
  });

  const first = await fetch(`${baseUrl}/atagent/api/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: "/echo hello"
    })
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${baseUrl}/atagent/api/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: "/echo again"
    })
  });
  assert.equal(second.status, 429);
});

test("api returns 400 for invalid JSON payload", async (t) => {
  const { baseUrl } = await startAgentServer(t, {
    actionsConfig: {
      version: "1.0.0",
      actions: []
    }
  });

  const response = await fetch(`${baseUrl}/atagent/api/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: "{invalid-json"
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.message, "Invalid JSON body.");
});

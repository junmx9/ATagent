"use strict";

const http = require("node:http");
const path = require("node:path");
const { MemoryCacheStore } = require("./core/cache");
const { AIEngine, getMissingParams, parseDirectCommand } = require("./core/ai");
const { ConversationStore, MemoryStateStore } = require("./core/conversation");
const { PlanEngine } = require("./core/planner");
const { executePlan, resumePlanAfterAction } = require("./core/plan_runtime");
const { JsonFileStateStore, JsonFileCacheStore } = require("./core/json_store");
const { ConfigStore } = require("./core/loader");
const { executeAction } = require("./core/executor");
const { createHttpHandler } = require("./core/server");
const { randomId } = require("./core/utils");

const DEFAULT_MESSAGES = {
  unresolved:
    "我还是没能理解您的意图，您可以直接输入 /动作名 来精确操作，例如 /add_todo 明天开会。",
  askClarify: "我没太明白您想做什么，能说得更具体一点吗？",
  candidatePrompt: "您是想执行以下哪个操作？",
  configChanged: "配置已更新，当前会话已失效，请重新发起请求。",
  missingHandler: '动作 "{action}" 尚未注册处理器。',
  missingAction: "未找到指定动作。",
  confirm: '确认执行“{action}”吗？',
  success: "操作已完成。",
  adminRequired: "该操作需要管理员权限。",
  aiUnavailable: "AI 服务暂时不可用，请稍后重试。"
};

class ATAgent {
  constructor(options = {}) {
    const rootDir = options.rootDir || __dirname;
    const configPath =
      options.configPath || path.join(rootDir, "config", "actions.json");
    const aiConfigPath =
      options.aiConfigPath ||
      path.join(path.dirname(configPath), "ai.json");

    this.maxClarifyRounds = Number.isInteger(options.maxClarifyRounds)
      ? options.maxClarifyRounds
      : 2;
    this.maxCandidates = Number.isInteger(options.maxCandidates)
      ? options.maxCandidates
      : 3;
    this.maxPlanSteps = Number.isInteger(options.maxPlanSteps)
      ? options.maxPlanSteps
      : 6;
    this.maxPlanReplans = Number.isInteger(options.maxPlanReplans)
      ? options.maxPlanReplans
      : 2;
    this.messages = { ...DEFAULT_MESSAGES, ...(options.messages || {}) };
    this.uiBasePath = options.uiBasePath || "/atagent";
    this.handlers = {};
    this.server = null;
    this.serverOptions = normalizeServerOptions(options.server);
    this.cacheStore =
      options.cacheStore && typeof options.cacheStore === "object"
        ? options.cacheStore
        : new MemoryCacheStore();

    this.configStore = new ConfigStore({
      actionsPath: configPath,
      aiPath: aiConfigPath,
      aiDefaults: options.ai || {}
    });
    this.snapshot = this.configStore.load();

    this.conversations = new ConversationStore({
      ttlMs: options.sessionTtlMs,
      confirmationTtlMs: options.confirmationTtlMs,
      sessionStore: options.sessionStore,
      confirmationStore: options.confirmationStore
    });
    this.aiEngine = new AIEngine({
      getSettings: () => this.getAiSettings()
    });
    this.planEngine =
      options.planEngine && typeof options.planEngine === "object"
        ? options.planEngine
        : new PlanEngine({
            getSettings: () => this.getAiSettings(),
            analyze: (payload) => this.aiEngine.analyze(payload)
          });

    if (options.watchConfig !== false) {
      this.configStore.watch((snapshot) => {
        this.snapshot = snapshot;
      });
    }
  }

  registerHandlers(handlers) {
    this.handlers = { ...this.handlers, ...(handlers || {}) };
    return this;
  }

  getActionsConfig() {
    this.snapshot = this.configStore.getSnapshot();
    return this.snapshot.actionsConfig;
  }

  getAiSettings() {
    this.snapshot = this.configStore.getSnapshot();
    return this.snapshot.aiSettings;
  }

  saveActions(config) {
    this.snapshot = this.configStore.saveActions(config);
    return this.snapshot.actionsConfig;
  }

  saveAiSettings(settings) {
    this.snapshot = this.configStore.saveAiSettings(settings);
    return this.snapshot.aiSettings;
  }

  listActions() {
    return this.getActionsConfig().actions.filter((action) => action.enabled);
  }

  findAction(name) {
    return this.getActionsConfig().actions.find((action) => action.name === name);
  }

  selectActionsForAnalysis(context = {}) {
    const actions = this.listActions();
    const contextTags = normalizeContextTags(context.tags);
    if (contextTags.length === 0) {
      return actions;
    }

    const filtered = actions.filter((action) =>
      action.tags.some((tag) => contextTags.includes(normalizeTag(tag)))
    );
    return filtered.length > 0 ? filtered : actions;
  }

  async execute(input, options = {}) {
    const request = this.normalizeRequest(input, options);
    if (!request.input) {
      return this.buildUnresolved();
    }

    if (request.mode === "goal") {
      return this.executeGoal(request);
    }

    const directCommand = parseDirectCommand(request.input, this.listActions());
    if (directCommand) {
      return this.executeResolvedAction({
        action: directCommand.action,
        params: directCommand.params,
        context: request.context,
        sessionId: request.sessionId,
        originalInput: request.input
      });
    }

    const analysis = await this.aiEngine.analyze({
      input: request.input,
      actions: this.selectActionsForAnalysis(request.context),
      context: request.context,
      maxCandidates: this.maxCandidates
    });

    return this.handleAnalysisResult({
      analysis,
      context: request.context,
      sessionId: request.sessionId,
      originalInput: request.input
    });
  }

  async continue(input, sessionOrOptions, extraOptions = {}) {
    const request = this.normalizeContinueRequest(
      input,
      sessionOrOptions,
      extraOptions
    );
    if (!request.sessionId) {
      return this.buildUnresolved();
    }

    const session = await this.conversations.getSession(request.sessionId);
    if (!session || session.kind !== "clarify") {
      return this.buildUnresolved();
    }

    const currentVersion = this.getActionsConfig().version;
    if (session.configVersion !== currentVersion) {
      await this.conversations.clearSession(request.sessionId);
      return this.buildUnresolved(this.messages.configChanged);
    }

    if (!session.actionName) {
      await this.conversations.clearSession(request.sessionId);
      return this.execute(request.input, {
        context: request.context,
        sessionId: request.sessionId,
        mode: session.mode
      });
    }

    const action = this.findAction(session.actionName);
    if (!action || !action.enabled) {
      await this.conversations.clearSession(request.sessionId);
      return this.buildUnresolved(this.messages.missingAction);
    }

    const analysis = await this.aiEngine.analyze({
      input: request.input,
      actions: [action],
      context: request.context,
      pendingAction: action,
      partialParams: session.params,
      maxCandidates: 1
    });

    if (analysis.type === "error") {
      return this.buildAnalysisError(analysis.error, {
        action: action.name,
        sessionId: request.sessionId
      });
    }

    const nextParams = analysis.params || session.params || {};
    const missingParams = getMissingParams(action, nextParams);
    if (missingParams.length > 0) {
      const nextRound = session.clarifyRound + 1;
      if (nextRound > this.maxClarifyRounds) {
        await this.conversations.clearSession(request.sessionId);
        return this.buildUnresolved(
          `我还是没能理解您的意图，您可以直接输入 /${action.name} 来精确操作。`
        );
      }

      await this.conversations.updateSession(request.sessionId, {
        params: nextParams,
        missingParams,
        clarifyRound: nextRound,
        updatedAt: Date.now()
      });
      return {
        status: "needs_more_info",
        action: action.name,
        missing_params: missingParams,
        question:
          analysis.question || this.aiEngine.buildClarifyQuestion(action, missingParams),
        clarifyRound: nextRound,
        sessionId: request.sessionId
      };
    }

    await this.conversations.clearSession(request.sessionId);

    if (!session.planSessionId) {
      return this.executeResolvedAction({
        action,
        params: nextParams,
        context: request.context,
        sessionId: request.sessionId,
        originalInput: request.input
      });
    }

    const stepResult = await this.performActionExecution({
      action,
      params: nextParams,
      context: request.context,
      sessionId: session.planSessionId,
      preConfirmed: false,
      confirmationMeta: {
        planSessionId: session.planSessionId,
        planStepId: session.planStep?.id
      }
    });

    if (stepResult.status === "requires_confirmation") {
      return {
        ...stepResult,
        mode: "goal",
        planId: session.planSessionId,
        current_step: session.planStep || null
      };
    }

    return this.resumePlanAfterStep({
      planSessionId: session.planSessionId,
      stepResult,
      context: request.context
    });
  }

  async confirm(confirmToken, options = {}) {
    if (!confirmToken) {
      return this.buildUnresolved();
    }

    const record = await this.conversations.consumeConfirmation(confirmToken);
    if (!record) {
      return this.buildUnresolved("确认已过期，请重新发起请求。");
    }

    const action = this.findAction(record.actionName);
    if (!action || !action.enabled) {
      return this.buildUnresolved(this.messages.missingAction);
    }

    const context = { ...(record.context || {}), ...(options.context || {}) };
    const result = await this.performActionExecution({
      action,
      params: record.params,
      context,
      sessionId: options.sessionId || record.sessionId,
      preConfirmed: true
    });

    if (record.planSessionId) {
      return this.resumePlanAfterStep({
        planSessionId: record.planSessionId,
        stepResult: result,
        context
      });
    }

    return result;
  }

  middleware(options = {}) {
    return createHttpHandler(this, {
      basePath: options.basePath || this.uiBasePath,
      security: mergeServerSecurity(this.serverOptions.security, options.security)
    });
  }

  startServer(port = 3001, options = {}) {
    if (this.server) {
      return this.server;
    }

    const handler = createHttpHandler(this, {
      basePath: options.basePath || this.uiBasePath,
      security: mergeServerSecurity(this.serverOptions.security, options.security)
    });
    this.server = http.createServer(handler);
    this.server.listen(port, options.host || "0.0.0.0");
    return this.server;
  }

  async stopServer() {
    if (!this.server) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.server = null;
  }

  async close() {
    await this.stopServer();
    this.configStore.close();
  }

  normalizeRequest(input, options = {}) {
    return {
      input: typeof input === "string" ? input.trim() : "",
      context: options.context || {},
      sessionId: options.sessionId || null,
      mode: options.mode === "goal" ? "goal" : "action"
    };
  }

  normalizeContinueRequest(input, sessionOrOptions, extraOptions) {
    if (
      sessionOrOptions &&
      typeof sessionOrOptions === "object" &&
      !Array.isArray(sessionOrOptions)
    ) {
      return {
        input: typeof input === "string" ? input.trim() : "",
        sessionId: sessionOrOptions.sessionId || null,
        context: sessionOrOptions.context || {}
      };
    }

    return {
      input: typeof input === "string" ? input.trim() : "",
      sessionId: sessionOrOptions || null,
      context: extraOptions.context || {}
    };
  }

  async handleAnalysisResult({ analysis, context, sessionId, originalInput }) {
    if (analysis.type === "error") {
      return this.buildAnalysisError(analysis.error, { sessionId });
    }

    if (analysis.type === "candidates") {
      return {
        status: "multiple_candidates",
        candidates: analysis.candidates,
        message: this.messages.candidatePrompt
      };
    }

    if (analysis.type === "clarify") {
      const action = analysis.action ? this.findAction(analysis.action) : null;
      const generatedSessionId = sessionId || randomId("session");
      const missingParams = analysis.missingParams || [];
      await this.conversations.createClarification(generatedSessionId, {
        actionName: action ? action.name : analysis.action,
        params: analysis.params || {},
        missingParams,
        clarifyRound: 1,
        configVersion: this.getActionsConfig().version,
        originalInput,
        updatedAt: Date.now()
      });
      return {
        status: "needs_more_info",
        action: action ? action.name : analysis.action,
        missing_params: missingParams,
        question:
          analysis.question ||
          (action && this.aiEngine.buildClarifyQuestion(action, missingParams)) ||
          this.messages.askClarify,
        clarifyRound: 1,
        sessionId: generatedSessionId
      };
    }

    const action = this.findAction(analysis.action);
    if (!action) {
      return this.buildUnresolved(this.messages.missingAction);
    }

    return this.executeResolvedAction({
      action,
      params: analysis.params || {},
      context,
      sessionId,
      originalInput
    });
  }

  async executeResolvedAction({
    action,
    params,
    context,
    sessionId,
    originalInput
  }) {
    const missingParams = getMissingParams(action, params);
    if (missingParams.length > 0) {
      const generatedSessionId = sessionId || randomId("session");
      await this.conversations.createClarification(generatedSessionId, {
        actionName: action.name,
        params,
        missingParams,
        clarifyRound: 1,
        configVersion: this.getActionsConfig().version,
        originalInput,
        updatedAt: Date.now()
      });
      return {
        status: "needs_more_info",
        action: action.name,
        missing_params: missingParams,
        question: this.aiEngine.buildClarifyQuestion(action, missingParams),
        clarifyRound: 1,
        sessionId: generatedSessionId
      };
    }

    return this.performActionExecution({
      action,
      params,
      context,
      sessionId,
      preConfirmed: false
    });
  }

  async executeGoal(request) {
    const actions = this.selectActionsForAnalysis(request.context);
    const plan = await this.planEngine.createPlan({
      input: request.input,
      actions,
      context: request.context,
      maxSteps: this.maxPlanSteps
    });

    if (plan.type === "error") {
      return {
        status: "error",
        mode: "goal",
        message: plan.error.message,
        error: plan.error
      };
    }

    if (plan.type === "clarify") {
      const generatedSessionId = request.sessionId || randomId("session");
      await this.conversations.createClarification(generatedSessionId, {
        actionName: null,
        params: {},
        missingParams: [],
        clarifyRound: 1,
        configVersion: this.getActionsConfig().version,
        originalInput: request.input,
        mode: "goal",
        updatedAt: Date.now()
      });
      return {
        status: "needs_more_info",
        mode: "goal",
        action: null,
        missing_params: [],
        question: plan.question || this.messages.askClarify,
        clarifyRound: 1,
        sessionId: generatedSessionId
      };
    }

    return executePlan({
      input: request.input,
      plan,
      context: request.context,
      actions,
      messages: this.messages,
      conversations: this.conversations,
      actionResolver: (name) => this.findAction(name),
      executeAction: (payload) => this.performActionExecution(payload),
      buildClarifyQuestion: (action, missingParams) =>
        this.aiEngine.buildClarifyQuestion(action, missingParams),
      configVersion: this.getActionsConfig().version,
      planEngine: this.planEngine,
      maxPlanSteps: this.maxPlanSteps,
      maxPlanReplans: this.maxPlanReplans
    });
  }

  async resumePlanAfterStep({ planSessionId, stepResult, context }) {
    return resumePlanAfterAction({
      planSessionId,
      stepResult,
      context,
      actions: this.selectActionsForAnalysis(context),
      messages: this.messages,
      conversations: this.conversations,
      actionResolver: (name) => this.findAction(name),
      executeAction: (payload) => this.performActionExecution(payload),
      buildClarifyQuestion: (action, missingParams) =>
        this.aiEngine.buildClarifyQuestion(action, missingParams),
      configVersion: this.getActionsConfig().version,
      planEngine: this.planEngine
    });
  }

  async performActionExecution({
    action,
    params,
    context,
    sessionId,
    preConfirmed,
    confirmationMeta
  }) {
    return executeAction({
      action,
      params,
      context,
      handlers: this.handlers,
      messages: this.messages,
      conversations: this.conversations,
      sessionId,
      configVersion: this.getActionsConfig().version,
      preConfirmed,
      cacheStore: this.cacheStore,
      actionResolver: (name) => this.findAction(name),
      confirmationMeta
    });
  }

  buildAnalysisError(error, extras = {}) {
    return {
      status: "error",
      message: error?.message || this.messages.aiUnavailable,
      error: {
        code: error?.code || "ai_request_failed",
        retryable: error?.retryable === true,
        statusCode: error?.statusCode || 502
      },
      ...extras
    };
  }

  buildUnresolved(message) {
    return {
      status: "unresolved",
      message: message || this.messages.unresolved
    };
  }
}

function normalizeContextTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => normalizeTag(tag)).filter(Boolean);
  }
  if (typeof tags === "string" && tags.trim()) {
    return tags
      .split(",")
      .map((tag) => normalizeTag(tag))
      .filter(Boolean);
  }
  return [];
}

function normalizeTag(tag) {
  return String(tag || "").trim().toLowerCase();
}

function normalizeServerOptions(server) {
  return {
    security: server && typeof server === "object" ? server.security || server : {}
  };
}

function mergeServerSecurity(baseSecurity, overrideSecurity) {
  return {
    ...(baseSecurity || {}),
    ...(overrideSecurity || {})
  };
}

module.exports = ATAgent;
module.exports.MemoryStateStore = MemoryStateStore;
module.exports.MemoryCacheStore = MemoryCacheStore;
module.exports.JsonFileStateStore = JsonFileStateStore;
module.exports.JsonFileCacheStore = JsonFileCacheStore;

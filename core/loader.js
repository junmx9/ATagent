"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { deepClone } = require("./utils");

const DEFAULT_AI_SETTINGS = {
  baseURL: "",
  apiKey: "",
  model: "",
  maxTokens: 1024,
  temperature: 0.1,
  systemPrompt: "",
  timeoutMs: 10000,
  maxRetries: 1,
  allowHeuristicFallback: false
};

const DEFAULT_ACTIONS_CONFIG = {
  version: "1.0.0",
  actions: []
};

class ConfigStore {
  constructor({ actionsPath, aiPath, aiDefaults = {} }) {
    this.actionsPath = path.resolve(actionsPath);
    this.aiPath = path.resolve(aiPath);
    this.aiDefaults = { ...DEFAULT_AI_SETTINGS, ...aiDefaults };
    this.snapshot = null;
    this.watchers = [];
    this.reloadTimer = null;
  }

  load() {
    const actionsConfig = normalizeActionsConfig(
      readJsonFile(this.actionsPath, DEFAULT_ACTIONS_CONFIG)
    );
    const aiSettings = normalizeAiSettings(
      readJsonFile(this.aiPath, this.aiDefaults),
      this.aiDefaults
    );
    this.snapshot = { actionsConfig, aiSettings };
    return deepClone(this.snapshot);
  }

  getSnapshot() {
    if (!this.snapshot) {
      return this.load();
    }
    return deepClone(this.snapshot);
  }

  saveActions(config) {
    const actionsConfig = normalizeActionsConfig(config);
    writeJsonFile(this.actionsPath, actionsConfig);
    const aiSettings = this.getSnapshot().aiSettings;
    this.snapshot = { actionsConfig, aiSettings };
    return this.getSnapshot();
  }

  saveAiSettings(settings) {
    const aiSettings = normalizeAiSettings(settings, this.aiDefaults);
    writeJsonFile(this.aiPath, aiSettings);
    const actionsConfig = this.getSnapshot().actionsConfig;
    this.snapshot = { actionsConfig, aiSettings };
    return this.getSnapshot();
  }

  watch(onChange) {
    this.close();
    for (const filePath of [this.actionsPath, this.aiPath]) {
      const directory = path.dirname(filePath);
      const fileName = path.basename(filePath);
      const watcher = fs.watch(directory, (eventType, changedFile) => {
        if (changedFile && changedFile !== fileName) {
          return;
        }
        if (eventType !== "change" && eventType !== "rename") {
          return;
        }

        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          try {
            const snapshot = this.load();
            if (typeof onChange === "function") {
              onChange(snapshot);
            }
          } catch {
          }
        }, 60);
      });
      this.watchers.push(watcher);
    }
  }

  close() {
    clearTimeout(this.reloadTimer);
    while (this.watchers.length > 0) {
      const watcher = this.watchers.pop();
      watcher.close();
    }
  }
}

function normalizeActionsConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("actions.json must be a JSON object.");
  }

  const version =
    typeof config.version === "string" && config.version.trim()
      ? config.version.trim()
      : "1.0.0";
  const sourceActions = Array.isArray(config.actions) ? config.actions : [];
  const names = new Set();

  const actions = sourceActions.map((action, index) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(`Action at index ${index} must be an object.`);
    }

    const name = String(action.name || "").trim();
    if (!name) {
      throw new Error(`Action at index ${index} is missing a name.`);
    }
    if (names.has(name)) {
      throw new Error(`Duplicate action name "${name}".`);
    }
    names.add(name);

    const normalizedAction = {
      ...action,
      name,
      description: String(action.description || "").trim(),
      parameters: normalizeParameters(action.parameters || [], name),
      examples: normalizeStringArray(action.examples),
      messages:
        action.messages && typeof action.messages === "object" && !Array.isArray(action.messages)
          ? { ...action.messages }
          : {},
      permission: normalizePermission(action.permission),
      enabled: action.enabled !== false,
      tags: normalizeStringArray(action.tags)
    };

    const cache = normalizeCacheConfig(action.cache);
    if (cache) {
      normalizedAction.cache = cache;
    } else {
      delete normalizedAction.cache;
    }

    const workflow = normalizeWorkflowConfig(action.workflow, name);
    if (workflow) {
      normalizedAction.workflow = workflow;
    } else {
      delete normalizedAction.workflow;
    }

    return normalizedAction;
  });

  return { version, actions };
}

function normalizeParameters(parameters, actionName) {
  const names = new Set();
  return parameters.map((parameter, index) => {
    if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
      throw new Error(
        `Parameter at index ${index} in action "${actionName}" must be an object.`
      );
    }

    const name = String(parameter.name || "").trim();
    if (!name) {
      throw new Error(
        `Parameter at index ${index} in action "${actionName}" is missing a name.`
      );
    }
    if (names.has(name)) {
      throw new Error(
        `Duplicate parameter name "${name}" in action "${actionName}".`
      );
    }
    names.add(name);

    return {
      ...parameter,
      name,
      type: String(parameter.type || "string").trim() || "string",
      description: String(parameter.description || "").trim(),
      required: Boolean(parameter.required)
    };
  });
}

function normalizePermission(permission) {
  const allowed = new Set(["normal", "confirm", "admin"]);
  const normalized = String(permission || "normal").trim();
  return allowed.has(normalized) ? normalized : "normal";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeCacheConfig(cache) {
  if (cache === true) {
    return {
      enabled: true,
      ttlMs: 60 * 1000,
      contextKeys: []
    };
  }

  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return null;
  }

  if (cache.enabled === false) {
    return null;
  }

  const ttlMs = Number(cache.ttlMs);
  return {
    enabled: true,
    ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 60 * 1000,
    contextKeys: normalizeStringArray(cache.contextKeys)
  };
}

function normalizeWorkflowConfig(workflow, actionName) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return null;
  }

  const sourceSteps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (sourceSteps.length === 0) {
    return null;
  }

  const stepIds = new Set();
  const steps = sourceSteps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(
        `Workflow step at index ${index} in action "${actionName}" must be an object.`
      );
    }

    const action = String(step.action || "").trim();
    if (!action) {
      throw new Error(
        `Workflow step at index ${index} in action "${actionName}" is missing an action.`
      );
    }

    const id = String(step.id || `step_${index + 1}`).trim();
    if (!id) {
      throw new Error(
        `Workflow step at index ${index} in action "${actionName}" is missing an id.`
      );
    }
    if (stepIds.has(id)) {
      throw new Error(
        `Duplicate workflow step id "${id}" in action "${actionName}".`
      );
    }
    stepIds.add(id);

    const params = normalizeWorkflowParams(step.params, actionName, id);
    const compensate = normalizeCompensation(step.compensate, actionName, id);
    return { id, action, params, compensate };
  });

  return { steps };
}

function normalizeWorkflowParams(params, actionName, stepId) {
  if (params === undefined) {
    return {};
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(
      `Workflow step "${stepId}" in action "${actionName}" must use an object for params.`
    );
  }
  return deepClone(params);
}

function normalizeCompensation(compensate, actionName, stepId) {
  if (compensate === undefined) {
    return null;
  }
  if (!compensate || typeof compensate !== "object" || Array.isArray(compensate)) {
    throw new Error(
      `Workflow step "${stepId}" in action "${actionName}" must use an object for compensate.`
    );
  }

  const action = String(compensate.action || "").trim();
  if (!action) {
    throw new Error(
      `Workflow step "${stepId}" in action "${actionName}" compensation is missing an action.`
    );
  }

  return {
    action,
    params: normalizeWorkflowParams(compensate.params, actionName, `${stepId}.compensate`)
  };
}

function normalizeAiSettings(settings, defaults = DEFAULT_AI_SETTINGS) {
  const normalized = {
    ...DEFAULT_AI_SETTINGS,
    ...defaults,
    ...(settings || {})
  };
  normalized.baseURL = String(normalized.baseURL || "").trim().replace(/\/+$/, "");
  normalized.apiKey = String(normalized.apiKey || "").trim();
  normalized.model = String(normalized.model || "").trim();
  normalized.systemPrompt = String(normalized.systemPrompt || "").trim();
  normalized.maxTokens = Number.isFinite(Number(normalized.maxTokens))
    ? Number(normalized.maxTokens)
    : 1024;
  normalized.temperature = Number.isFinite(Number(normalized.temperature))
    ? Number(normalized.temperature)
    : 0.1;
  normalized.timeoutMs = Number.isFinite(Number(normalized.timeoutMs))
    ? Number(normalized.timeoutMs)
    : 10000;
  normalized.maxRetries =
    Number.isInteger(Number(normalized.maxRetries)) && Number(normalized.maxRetries) >= 0
    ? Number(normalized.maxRetries)
    : 1;
  normalized.allowHeuristicFallback = normalized.allowHeuristicFallback === true;
  return normalized;
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return deepClone(fallback);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return deepClone(fallback);
  }
  return JSON.parse(raw);
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

module.exports = {
  ConfigStore,
  DEFAULT_AI_SETTINGS,
  normalizeActionsConfig,
  normalizeAiSettings
};

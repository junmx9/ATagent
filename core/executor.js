"use strict";

const { buildCacheKey } = require("./cache");
const { deepClone, renderTemplate } = require("./utils");

const WORKFLOW_TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

async function executeAction({
  action,
  params,
  context = {},
  handlers,
  messages,
  conversations,
  sessionId,
  configVersion,
  preConfirmed,
  cacheStore,
  actionResolver,
  executionPath = []
}) {
  const entry = normalizeHandlerEntry(handlers[action.name]);
  if (action.permission === "admin" && !context.isAdmin) {
    return {
      status: "blocked",
      action: action.name,
      message: messages.adminRequired
    };
  }

  if (entry?.canExecute) {
    try {
      const decision = await entry.canExecute({
        action,
        params,
        context
      });
      if (decision && decision.allowed === false) {
        return {
          status: "blocked",
          action: action.name,
          message: decision.reason || "当前上下文不允许执行该操作。",
          suggestedAction: decision.suggestedAction
        };
      }
    } catch (error) {
      return buildActionError(action.name, error, "Action guard failed.");
    }
  }

  if (action.permission === "confirm" && !preConfirmed) {
    const confirmToken = await conversations.createConfirmation({
      actionName: action.name,
      params,
      context,
      sessionId,
      configVersion
    });
    const template =
      action.messages.confirm || messages.confirm || '确认执行“{action}”吗？';
    return {
      status: "requires_confirmation",
      action: action.name,
      message: renderTemplate(template, { ...params, action: action.name }),
      confirmToken,
      sessionId
    };
  }

  if (action.workflow?.steps?.length) {
    return executeWorkflow({
      action,
      params,
      context,
      handlers,
      messages,
      conversations,
      sessionId,
      configVersion,
      preConfirmed,
      cacheStore,
      actionResolver,
      executionPath
    });
  }

  const cached = await readCachedResult({
    action,
    params,
    context,
    cacheStore,
    configVersion
  });
  if (cached) {
    return cached;
  }

  if (!entry?.handler) {
    return {
      status: "error",
      action: action.name,
      message: renderTemplate(messages.missingHandler, { action: action.name }),
      error: {
        code: "missing_handler"
      }
    };
  }

  let result;
  try {
    result = await entry.handler(params, context, action);
  } catch (error) {
    return buildActionError(action.name, error, `Action "${action.name}" failed.`);
  }

  const data =
    result && typeof result === "object" && !Array.isArray(result) ? result.data : result;
  const message =
    result && typeof result === "object" && result.message
      ? result.message
      : renderTemplate(action.messages.success || messages.success, {
          ...params,
          action: action.name
        });

  const response = {
    status: "success",
    action: action.name,
    message,
    data
  };
  await writeCachedResult({
    action,
    params,
    context,
    response,
    cacheStore,
    configVersion
  });
  return response;
}

async function executeWorkflow({
  action,
  params,
  context,
  handlers,
  messages,
  conversations,
  sessionId,
  configVersion,
  preConfirmed,
  cacheStore,
  actionResolver,
  executionPath
}) {
  if (executionPath.includes(action.name)) {
    return {
      status: "error",
      action: action.name,
      message: `Circular workflow detected: ${[...executionPath, action.name].join(" -> ")}`,
      error: {
        code: "workflow_cycle"
      }
    };
  }

  const cached = await readCachedResult({
    action,
    params,
    context,
    cacheStore,
    configVersion
  });
  if (cached) {
    return cached;
  }

  if (typeof actionResolver !== "function") {
    return {
      status: "error",
      action: action.name,
      message: `Workflow action "${action.name}" cannot resolve step actions.`,
      error: {
        code: "workflow_resolver_missing"
      }
    };
  }

  const nextPath = [...executionPath, action.name];
  const stepResults = {};
  const completedSteps = [];
  let lastStepResult = null;

  for (const step of action.workflow.steps) {
    const stepAction = actionResolver(step.action);
    if (!stepAction || !stepAction.enabled) {
      const failure = {
        status: "error",
        action: action.name,
        message: `Workflow step "${step.id}" references unavailable action "${step.action}".`,
        error: {
          code: "workflow_missing_step_action"
        }
      };
      return attachWorkflowFailure(action.name, step.id, failure, []);
    }

    if (!preConfirmed && stepAction.permission === "confirm") {
      const failure = {
        status: "error",
        action: action.name,
        message:
          `Workflow step "${step.id}" requires confirmation. ` +
          `Set the parent workflow action "${action.name}" to confirm before execution.`,
        error: {
          code: "workflow_step_requires_confirmation"
        }
      };
      return attachWorkflowFailure(action.name, step.id, failure, []);
    }

    const stepParams = resolveWorkflowValue(step.params || {}, {
      params,
      context,
      steps: stepResults
    });
    const stepContext = {
      ...context,
      workflow: {
        action: action.name,
        params: cloneValue(params),
        steps: cloneValue(stepResults),
        currentStepId: step.id
      }
    };

    const stepResult = await executeAction({
      action: stepAction,
      params: stepParams,
      context: stepContext,
      handlers,
      messages,
      conversations,
      sessionId,
      configVersion,
      preConfirmed,
      cacheStore,
      actionResolver,
      executionPath: nextPath
    });

    if (stepResult.status !== "success") {
      const compensation = await runCompensations({
        parentAction: action,
        params,
        context,
        completedSteps,
        handlers,
        messages,
        conversations,
        sessionId,
        configVersion,
        cacheStore,
        actionResolver,
        executionPath: nextPath
      });
      return attachWorkflowFailure(action.name, step.id, stepResult, compensation);
    }

    stepResults[step.id] = {
      status: stepResult.status,
      action: stepResult.action,
      message: stepResult.message,
      data: cloneValue(stepResult.data)
    };
    completedSteps.push({
      step,
      stepAction,
      stepParams: cloneValue(stepParams),
      stepResult: cloneValue(stepResults[step.id]),
      stepResultsSnapshot: cloneValue(stepResults)
    });
    lastStepResult = stepResult;
  }

  const response = {
    status: "success",
    action: action.name,
    message: buildWorkflowSuccessMessage(action, params, messages, lastStepResult),
    data: {
      steps: cloneValue(stepResults),
      lastStep: lastStepResult
        ? {
            action: lastStepResult.action,
            message: lastStepResult.message,
            data: cloneValue(lastStepResult.data)
          }
        : null
    }
  };
  await writeCachedResult({
    action,
    params,
    context,
    response,
    cacheStore,
    configVersion
  });
  return response;
}

function buildWorkflowSuccessMessage(action, params, messages, lastStepResult) {
  if (action.messages.success) {
    return renderTemplate(action.messages.success, {
      ...params,
      action: action.name
    });
  }
  if (lastStepResult?.message) {
    return lastStepResult.message;
  }
  return renderTemplate(messages.success, {
    ...params,
    action: action.name
  });
}

async function runCompensations({
  parentAction,
  params,
  context,
  completedSteps,
  handlers,
  messages,
  conversations,
  sessionId,
  configVersion,
  cacheStore,
  actionResolver,
  executionPath
}) {
  const results = [];

  for (const entry of [...completedSteps].reverse()) {
    if (!entry.step.compensate) {
      continue;
    }

    const compensationAction = actionResolver(entry.step.compensate.action);
    if (!compensationAction || !compensationAction.enabled) {
      results.push({
        stepId: entry.step.id,
        action: entry.step.compensate.action,
        status: "error",
        message:
          `Compensation action "${entry.step.compensate.action}" is unavailable.`
      });
      continue;
    }

    const compensationParams = resolveWorkflowValue(entry.step.compensate.params || {}, {
      params,
      context,
      steps: entry.stepResultsSnapshot
    });
    const compensationContext = {
      ...context,
      workflow: {
        action: parentAction.name,
        params: cloneValue(params),
        steps: cloneValue(entry.stepResultsSnapshot),
        currentStepId: entry.step.id,
        compensation: true
      }
    };

    const result = await executeAction({
      action: compensationAction,
      params: compensationParams,
      context: compensationContext,
      handlers,
      messages,
      conversations,
      sessionId,
      configVersion,
      preConfirmed: true,
      cacheStore,
      actionResolver,
      executionPath
    });

    results.push({
      stepId: entry.step.id,
      action: compensationAction.name,
      status: result.status,
      message: result.message,
      data: cloneValue(result.data)
    });
  }

  return results;
}

function attachWorkflowFailure(workflowAction, failedStep, failure, compensation) {
  return {
    ...failure,
    workflowAction,
    failedStep,
    compensation
  };
}

async function readCachedResult({ action, params, context, cacheStore, configVersion }) {
  if (!action.cache?.enabled || !cacheStore || typeof cacheStore.get !== "function") {
    return null;
  }

  const key = buildCacheKey({
    action,
    params,
    context,
    configVersion
  });
  return await cacheStore.get(key);
}

async function writeCachedResult({
  action,
  params,
  context,
  response,
  cacheStore,
  configVersion
}) {
  if (
    !action.cache?.enabled ||
    !cacheStore ||
    typeof cacheStore.set !== "function" ||
    !response ||
    response.status !== "success"
  ) {
    return;
  }

  const key = buildCacheKey({
    action,
    params,
    context,
    configVersion
  });
  await cacheStore.set(key, response, action.cache.ttlMs);
}

function buildActionError(actionName, error, fallbackMessage) {
  return {
    status: "error",
    action: actionName,
    message: error?.message || fallbackMessage,
    error: {
      code: "handler_error"
    }
  };
}

function normalizeHandlerEntry(entry) {
  if (!entry) {
    return null;
  }
  if (typeof entry === "function") {
    return { handler: entry };
  }
  if (typeof entry === "object") {
    return entry;
  }
  return null;
}

function resolveWorkflowValue(value, scope) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowValue(item, scope));
  }

  if (value && typeof value === "object") {
    return Object.entries(value).reduce((result, [key, item]) => {
      result[key] = resolveWorkflowValue(item, scope);
      return result;
    }, {});
  }

  if (typeof value !== "string") {
    return value;
  }

  const matches = [...value.matchAll(WORKFLOW_TEMPLATE_PATTERN)];
  if (matches.length === 0) {
    return value;
  }

  if (matches.length === 1 && matches[0][0] === value) {
    const resolved = getScopeValue(scope, matches[0][1]);
    return resolved === undefined ? "" : cloneValue(resolved);
  }

  return value.replace(WORKFLOW_TEMPLATE_PATTERN, (_, pathExpression) => {
    const resolved = getScopeValue(scope, pathExpression);
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}

function getScopeValue(scope, pathExpression) {
  const segments = String(pathExpression || "")
    .trim()
    .split(".")
    .filter(Boolean);
  let current = scope;
  for (const segment of segments) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function cloneValue(value) {
  return value === undefined ? undefined : deepClone(value);
}

module.exports = {
  executeAction
};

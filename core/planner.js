"use strict";

class PlanEngine {
  constructor({ getSettings, analyze } = {}) {
    this.getSettings = typeof getSettings === "function" ? getSettings : () => ({});
    this.analyze = typeof analyze === "function" ? analyze : null;
  }

  async createPlan({ input, actions, context = {}, maxSteps = 6 }) {
    const settings = this.getSettings();
    if (!hasRemoteModel(settings)) {
      return this.createPlanWithFallback({
        input,
        actions,
        context,
        maxSteps
      });
    }

    try {
      const payload = {
        mode: "plan",
        goal: input,
        context,
        maxSteps,
        actionSchema: mapActionSchema(actions)
      };
      const response = await requestPlannerCompletion(
        settings,
        payload,
        PLANNER_CREATE_SYSTEM_PROMPT
      );
      return normalizeCreatePlanResponse(response, input);
    } catch (error) {
      return {
        type: "error",
        error: normalizePlannerError(error)
      };
    }
  }

  async decideNext({
    goal,
    actions,
    context = {},
    completedSteps = [],
    remainingSteps = [],
    lastOutcome = null,
    maxSteps = 6
  }) {
    const settings = this.getSettings();
    if (!hasRemoteModel(settings)) {
      return this.decideNextWithFallback({
        remainingSteps,
        lastOutcome
      });
    }

    try {
      const payload = {
        mode: "next",
        goal,
        context,
        maxSteps,
        completedSteps,
        remainingSteps,
        lastOutcome,
        actionSchema: mapActionSchema(actions)
      };
      const response = await requestPlannerCompletion(
        settings,
        payload,
        PLANNER_NEXT_SYSTEM_PROMPT
      );
      return normalizeNextDecision(response);
    } catch (error) {
      return {
        type: "error",
        error: normalizePlannerError(error)
      };
    }
  }

  async createPlanWithFallback({ input, actions, context, maxSteps }) {
    if (!this.analyze) {
      return {
        type: "clarify",
        question: "请描述得更具体一些，方便我拆解执行计划。"
      };
    }

    const analysis = await this.analyze({
      input,
      actions,
      context,
      maxCandidates: Math.min(maxSteps, 3)
    });

    if (analysis.type === "error") {
      return analysis;
    }

    if (analysis.type === "candidates") {
      return {
        type: "clarify",
        question: "我需要先确定您要执行的操作，请再说具体一点。"
      };
    }

    if (!analysis.action) {
      return {
        type: "clarify",
        question: analysis.question || "请描述得更具体一些，方便我拆解执行计划。"
      };
    }

    return {
      type: "plan",
      goal: input,
      steps: [
        {
          id: "step_1",
          action: analysis.action,
          params: analysis.params || {},
          purpose: "Execute the matched action."
        }
      ]
    };
  }

  decideNextWithFallback({ remainingSteps, lastOutcome }) {
    if (lastOutcome && lastOutcome.status !== "success") {
      return {
        type: "fail",
        message: lastOutcome.message || "计划执行失败。"
      };
    }

    if (remainingSteps.length === 0) {
      return {
        type: "complete"
      };
    }

    return {
      type: "continue"
    };
  }
}

const PLANNER_CREATE_SYSTEM_PROMPT = [
  "You are a strict execution planner.",
  "Return only valid JSON.",
  'For mode "plan", return one of:',
  '- {"type":"plan","goal":"...","steps":[{"id":"step_1","action":"known_action","params":{},"purpose":"..."}]}',
  '- {"type":"clarify","question":"..."}',
  "Only use actions from actionSchema.",
  "Keep plans short, concrete, and executable."
].join(" ");

const PLANNER_NEXT_SYSTEM_PROMPT = [
  "You are a strict execution planner.",
  "Return only valid JSON.",
  'For mode "next", return one of:',
  '- {"type":"continue"} to keep remainingSteps as-is',
  '- {"type":"continue","steps":[...]} to replace remainingSteps',
  '- {"type":"complete","message":"..."} when the goal is satisfied',
  '- {"type":"fail","message":"..."} when the goal cannot proceed safely',
  "Only use actions from actionSchema."
].join(" ");

class PlannerRequestError extends Error {
  constructor(message, { code = "ai_request_failed", retryable = false, statusCode } = {}) {
    super(message);
    this.name = "PlannerRequestError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

async function requestPlannerCompletion(settings, payload, systemPrompt) {
  const timeoutMs = normalizePositiveInteger(settings.timeoutMs, 10000);
  const maxRetries = normalizeRetryCount(settings.maxRetries, 1);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestPlannerOnce(settings, payload, systemPrompt, timeoutMs);
    } catch (error) {
      const normalized = toPlannerRequestError(error);
      if (!normalized.retryable || attempt === maxRetries) {
        throw normalized;
      }
      await sleep(Math.min(250 * (attempt + 1), 1000));
    }
  }

  throw new PlannerRequestError("AI request failed after retries.", {
    code: "ai_request_failed",
    retryable: false
  });
}

async function requestPlannerOnce(settings, payload, systemPrompt, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${settings.baseURL}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(settings),
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: JSON.stringify(payload)
          }
        ]
      })
    });

    if (!response.ok) {
      throw new PlannerRequestError(`LLM request failed: ${response.status}`, {
        code: classifyStatusCode(response.status),
        retryable: isRetryableStatus(response.status),
        statusCode: response.status
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new PlannerRequestError("Missing response content.", {
        code: "ai_invalid_response",
        retryable: false,
        statusCode: 502
      });
    }

    return JSON.parse(content);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new PlannerRequestError(`AI request timed out after ${timeoutMs}ms.`, {
        code: "ai_timeout",
        retryable: true,
        statusCode: 504
      });
    }
    if (error instanceof SyntaxError) {
      throw new PlannerRequestError("AI response is not valid JSON.", {
        code: "ai_invalid_response",
        retryable: false,
        statusCode: 502
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeCreatePlanResponse(payload, goal) {
  if (!payload || typeof payload !== "object") {
    throw new PlannerRequestError("Invalid planner response shape.", {
      code: "ai_invalid_response",
      retryable: false,
      statusCode: 502
    });
  }

  if (payload.type === "clarify") {
    return {
      type: "clarify",
      question: String(payload.question || "").trim() || "请先补充目标细节。"
    };
  }

  const steps = normalizeSteps(payload.steps);
  if (steps.length === 0) {
    return {
      type: "clarify",
      question: "我还不能安全地拆出执行计划，请再补充目标。"
    };
  }

  return {
    type: "plan",
    goal: String(payload.goal || goal || "").trim(),
    steps
  };
}

function normalizeNextDecision(payload) {
  if (!payload || typeof payload !== "object") {
    throw new PlannerRequestError("Invalid planner response shape.", {
      code: "ai_invalid_response",
      retryable: false,
      statusCode: 502
    });
  }

  const type = String(payload.type || "continue").trim();
  if (type === "complete") {
    return {
      type: "complete",
      message: String(payload.message || "").trim()
    };
  }

  if (type === "fail") {
    return {
      type: "fail",
      message: String(payload.message || "").trim() || "计划执行失败。"
    };
  }

  return {
    type: "continue",
    steps: Array.isArray(payload.steps) ? normalizeSteps(payload.steps) : undefined,
    message: String(payload.message || "").trim()
  };
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) {
    return [];
  }

  return steps
    .map((step, index) => normalizeStep(step, index))
    .filter(Boolean);
}

function normalizeStep(step, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return null;
  }

  const action = String(step.action || "").trim();
  if (!action) {
    return null;
  }

  const params =
    step.params && typeof step.params === "object" && !Array.isArray(step.params)
      ? deepClone(step.params)
      : {};

  return {
    id: String(step.id || `step_${index + 1}`).trim() || `step_${index + 1}`,
    action,
    params,
    purpose: String(step.purpose || "").trim()
  };
}

function mapActionSchema(actions) {
  return actions.map((action) => ({
    name: action.name,
    description: action.description,
    parameters: action.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      description: parameter.description,
      required: parameter.required
    })),
    examples: action.examples,
    tags: action.tags
  }));
}

function buildHeaders(settings) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  return headers;
}

function hasRemoteModel(settings) {
  return Boolean(settings && settings.baseURL && settings.model);
}

function normalizePlannerError(error) {
  const normalized = toPlannerRequestError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    statusCode: normalized.statusCode || 502
  };
}

function toPlannerRequestError(error) {
  if (error instanceof PlannerRequestError) {
    return error;
  }
  return new PlannerRequestError(error?.message || "AI request failed.", {
    code: "ai_request_failed",
    retryable: false,
    statusCode: 502
  });
}

function classifyStatusCode(statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return "ai_auth_failed";
  }
  if (statusCode === 408 || statusCode === 504) {
    return "ai_timeout";
  }
  if (statusCode === 429) {
    return "ai_rate_limited";
  }
  if (statusCode >= 500) {
    return "ai_service_unavailable";
  }
  return "ai_request_failed";
}

function isRetryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRetryCount(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  PlanEngine
};

"use strict";

class AIRequestError extends Error {
  constructor(message, { code = "ai_request_failed", retryable = false, statusCode } = {}) {
    super(message);
    this.name = "AIRequestError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

class AIEngine {
  constructor({ getSettings }) {
    this.getSettings = getSettings;
  }

  async analyze({
    input,
    actions,
    context = {},
    pendingAction = null,
    partialParams = {},
    maxCandidates = 3
  }) {
    const settings = this.getSettings();
    const heuristicAnalysis = () =>
      this.analyzeWithHeuristics({
        input,
        actions,
        pendingAction,
        partialParams,
        maxCandidates
      });

    if (!hasRemoteModel(settings)) {
      return heuristicAnalysis();
    }

    try {
      return await this.analyzeWithRemoteModel({
        input,
        actions,
        context,
        pendingAction,
        partialParams,
        maxCandidates,
        settings
      });
    } catch (error) {
      if (settings.allowHeuristicFallback === true) {
        const fallback = heuristicAnalysis();
        fallback.fallback = {
          source: "heuristic",
          reason: error.message
        };
        return fallback;
      }

      return {
        type: "error",
        error: normalizeAiError(error)
      };
    }
  }

  buildClarifyQuestion(action, missingParams) {
    if (!action || !missingParams || missingParams.length === 0) {
      return "能补充一点信息吗？";
    }
    if (missingParams.length === 1) {
      const parameter = action.parameters.find(
        (item) => item.name === missingParams[0]
      );
      const label =
        parameter && parameter.description ? parameter.description : missingParams[0];
      return `请问${label}是什么？`;
    }
    return `还需要补充以下信息：${missingParams.join("、")}。`;
  }

  async analyzeWithRemoteModel({
    input,
    actions,
    context,
    pendingAction,
    partialParams,
    maxCandidates,
    settings
  }) {
    const payload = {
      mode: pendingAction ? "continue" : "match",
      input,
      context,
      partialParams,
      maxCandidates,
      actionSchema: actions.map((action) => ({
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
      }))
    };

    const maxRetries = normalizePositiveInteger(settings.maxRetries, 1);
    const timeoutMs = normalizePositiveInteger(settings.timeoutMs, 10000);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await requestCompletion(settings, payload, timeoutMs);
        return normalizeAnalysis(response, actions, this);
      } catch (error) {
        const normalizedError = toAiRequestError(error);
        if (!normalizedError.retryable || attempt === maxRetries) {
          throw normalizedError;
        }
        await sleep(Math.min(250 * (attempt + 1), 1000));
      }
    }

    throw new AIRequestError("AI request failed after retries.", {
      code: "ai_request_failed",
      retryable: false
    });
  }

  analyzeWithHeuristics({
    input,
    actions,
    pendingAction,
    partialParams,
    maxCandidates
  }) {
    if (pendingAction) {
      const params = mergeHeuristicParams(pendingAction, partialParams, input);
      const missingParams = getMissingParams(pendingAction, params);
      return {
        type: "clarify",
        action: pendingAction.name,
        params,
        missingParams,
        question: this.buildClarifyQuestion(pendingAction, missingParams)
      };
    }

    const ranked = actions
      .map((action) => ({
        action,
        score: scoreAction(input, action)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    if (ranked.length === 0) {
      return {
        type: "clarify",
        action: null,
        params: {},
        missingParams: [],
        question: "我没太明白您想做什么，能说得更具体一点吗？"
      };
    }

    const top = ranked[0];
    const second = ranked[1];
    if (second && Math.abs(top.score - second.score) <= 1) {
      return {
        type: "candidates",
        candidates: ranked.slice(0, maxCandidates).map((entry) => ({
          name: entry.action.name,
          description: entry.action.description,
          score: Number((entry.score / top.score).toFixed(2))
        }))
      };
    }

    const params = extractHeuristicParams(top.action, input);
    const missingParams = getMissingParams(top.action, params);
    if (missingParams.length > 0) {
      return {
        type: "clarify",
        action: top.action.name,
        params,
        missingParams,
        question: this.buildClarifyQuestion(top.action, missingParams)
      };
    }

    return {
      type: "match",
      action: top.action.name,
      params
    };
  }
}

function parseDirectCommand(input, actions) {
  if (typeof input !== "string" || !input.startsWith("/")) {
    return null;
  }

  const trimmed = input.trim();
  const firstSpace = trimmed.indexOf(" ");
  const command = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const rawArgs = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  const action = actions.find((item) => item.name === command);
  if (!action) {
    return null;
  }

  return {
    action,
    params: extractDirectParams(action, rawArgs)
  };
}

function getMissingParams(action, params = {}) {
  return action.parameters
    .filter((parameter) => parameter.required)
    .filter((parameter) => {
      const value = params[parameter.name];
      return value === undefined || value === null || String(value).trim() === "";
    })
    .map((parameter) => parameter.name);
}

function extractDirectParams(action, rawArgs) {
  const params = {};
  const keyValues = parseKeyValueArgs(rawArgs);
  if (Object.keys(keyValues).length > 0) {
    return keyValues;
  }

  if (action.parameters.length === 1 && rawArgs) {
    params[action.parameters[0].name] = rawArgs;
    return params;
  }

  if (rawArgs) {
    const values = rawArgs.split(/\s+/);
    action.parameters.forEach((parameter, index) => {
      if (values[index]) {
        params[parameter.name] = values[index];
      }
    });
  }

  return params;
}

function extractHeuristicParams(action, input) {
  const params = parseKeyValueArgs(input);
  if (Object.keys(params).length > 0) {
    return params;
  }

  if (action.parameters.length === 1 && action.parameters[0].type === "string") {
    const value = stripLeadingIntentPhrase(action, input);
    if (value) {
      params[action.parameters[0].name] = value;
    }
  }
  return params;
}

function mergeHeuristicParams(action, partialParams, input) {
  const params = { ...(partialParams || {}), ...parseKeyValueArgs(input) };
  const missing = getMissingParams(action, params);
  if (
    missing.length === 1 &&
    action.parameters.find((parameter) => parameter.name === missing[0])?.type === "string"
  ) {
    const value = input.trim();
    if (value) {
      params[missing[0]] = value;
    }
  }
  return params;
}

function scoreAction(input, action) {
  const normalizedInput = normalizeText(input);
  if (!normalizedInput) {
    return 0;
  }

  let score = 0;
  const sources = [
    action.name,
    action.description,
    ...(action.examples || []),
    ...(action.tags || [])
  ];
  for (const source of sources) {
    const normalizedSource = normalizeText(source);
    if (!normalizedSource) {
      continue;
    }
    if (normalizedInput === normalizedSource) {
      score += 6;
      continue;
    }
    if (normalizedInput.includes(normalizedSource) || normalizedSource.includes(normalizedInput)) {
      score += 4;
    }
    const terms = normalizedSource.split(/\s+/).filter(Boolean);
    for (const term of terms) {
      if (term.length >= 2 && normalizedInput.includes(term)) {
        score += 1;
      }
    }
  }
  return score;
}

function stripLeadingIntentPhrase(action, input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const candidates = [action.description, ...action.examples, action.name].filter(Boolean);
  for (const candidate of candidates) {
    if (trimmed === candidate) {
      return "";
    }
    if (trimmed.startsWith(`${candidate} `)) {
      return trimmed.slice(candidate.length).trim();
    }
    if (trimmed.startsWith(`${candidate}：`) || trimmed.startsWith(`${candidate}:`)) {
      return trimmed.slice(candidate.length + 1).trim();
    }
  }

  const colonIndex = Math.max(trimmed.lastIndexOf("："), trimmed.lastIndexOf(":"));
  if (colonIndex >= 0 && colonIndex < trimmed.length - 1) {
    return trimmed.slice(colonIndex + 1).trim();
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) {
    return parts.slice(1).join(" ").trim();
  }

  return "";
}

function parseKeyValueArgs(rawArgs) {
  const params = {};
  if (!rawArgs) {
    return params;
  }

  const pattern = /(\w+)=(".*?"|'.*?'|[^\s]+)/g;
  let match = pattern.exec(rawArgs);
  while (match) {
    const key = match[1];
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    params[key] = value;
    match = pattern.exec(rawArgs);
  }
  return params;
}

async function requestCompletion(settings, payload, timeoutMs) {
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
            content:
              settings.systemPrompt ||
              "You are a strict intent router. Return only valid JSON with keys type, action, params, missingParams, question, candidates."
          },
          {
            role: "user",
            content: JSON.stringify(payload)
          }
        ]
      })
    });

    if (!response.ok) {
      throw new AIRequestError(`LLM request failed: ${response.status}`, {
        code: classifyStatusCode(response.status),
        retryable: isRetryableStatus(response.status),
        statusCode: response.status
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new AIRequestError("Missing response content.", {
        code: "ai_invalid_response",
        retryable: false,
        statusCode: 502
      });
    }

    return JSON.parse(content);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AIRequestError(`AI request timed out after ${timeoutMs}ms.`, {
        code: "ai_timeout",
        retryable: true,
        statusCode: 504
      });
    }
    if (error instanceof SyntaxError) {
      throw new AIRequestError("AI response is not valid JSON.", {
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

function buildHeaders(settings) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  return headers;
}

function normalizeAnalysis(payload, actions, engine) {
  if (!payload || typeof payload !== "object") {
    throw new AIRequestError("Invalid AI response shape.", {
      code: "ai_invalid_response",
      retryable: false,
      statusCode: 502
    });
  }

  const knownNames = new Set(actions.map((action) => action.name));
  const type = payload.type || "clarify";
  if (type === "candidates" && Array.isArray(payload.candidates)) {
    return {
      type: "candidates",
      candidates: payload.candidates
        .filter((candidate) => knownNames.has(candidate.name))
        .map((candidate) => ({
          name: candidate.name,
          description: candidate.description || "",
          score: Number(candidate.score || 0)
        }))
    };
  }

  const actionName = typeof payload.action === "string" ? payload.action : null;
  const action = actions.find((item) => item.name === actionName);
  const params = payload.params && typeof payload.params === "object" ? payload.params : {};
  const missingParams = action
    ? getMissingParams(action, params)
    : Array.isArray(payload.missingParams)
      ? payload.missingParams
      : [];

  if (type === "match" && action) {
    if (missingParams.length > 0) {
      return {
        type: "clarify",
        action: action.name,
        params,
        missingParams,
        question: payload.question || engine.buildClarifyQuestion(action, missingParams)
      };
    }
    return {
      type: "match",
      action: action.name,
      params
    };
  }

  return {
    type: "clarify",
    action: action ? action.name : null,
    params,
    missingParams,
    question:
      payload.question ||
      (action ? engine.buildClarifyQuestion(action, missingParams) : undefined)
  };
}

function toAiRequestError(error) {
  if (error instanceof AIRequestError) {
    return error;
  }
  return new AIRequestError(error?.message || "AI request failed.", {
    code: "ai_request_failed",
    retryable: false,
    statusCode: 502
  });
}

function normalizeAiError(error) {
  const normalized = toAiRequestError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    statusCode: normalized.statusCode || 502
  };
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

function hasRemoteModel(settings) {
  return Boolean(settings && settings.baseURL && settings.model);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  AIEngine,
  getMissingParams,
  parseDirectCommand
};

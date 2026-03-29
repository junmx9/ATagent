"use strict";

const TOKEN_STORAGE_KEY = "atagent.accessToken";

const state = {
  config: { version: "1.0.0", actions: [] },
  selectedIndex: 0,
  settings: {},
  lastResponse: null
};

const elements = {
  actionList: document.querySelector("#action-list"),
  configVersion: document.querySelector("#config-version"),
  actionName: document.querySelector("#action-name"),
  actionDescription: document.querySelector("#action-description"),
  actionPermission: document.querySelector("#action-permission"),
  actionEnabled: document.querySelector("#action-enabled"),
  actionTags: document.querySelector("#action-tags"),
  actionExamples: document.querySelector("#action-examples"),
  messageSuccess: document.querySelector("#message-success"),
  messageConfirm: document.querySelector("#message-confirm"),
  actionParameters: document.querySelector("#action-parameters"),
  actionCache: document.querySelector("#action-cache"),
  actionWorkflow: document.querySelector("#action-workflow"),
  aiBaseUrl: document.querySelector("#ai-base-url"),
  aiApiKey: document.querySelector("#ai-api-key"),
  aiModel: document.querySelector("#ai-model"),
  aiMaxTokens: document.querySelector("#ai-max-tokens"),
  aiTemperature: document.querySelector("#ai-temperature"),
  aiTimeoutMs: document.querySelector("#ai-timeout-ms"),
  aiMaxRetries: document.querySelector("#ai-max-retries"),
  aiAllowFallback: document.querySelector("#ai-allow-fallback"),
  aiSystemPrompt: document.querySelector("#ai-system-prompt"),
  apiAccessToken: document.querySelector("#api-access-token"),
  reloadData: document.querySelector("#reload-data"),
  playInput: document.querySelector("#play-input"),
  playSession: document.querySelector("#play-session"),
  playContext: document.querySelector("#play-context"),
  playOutput: document.querySelector("#play-output"),
  addAction: document.querySelector("#add-action"),
  deleteAction: document.querySelector("#delete-action"),
  saveActions: document.querySelector("#save-actions"),
  exportActions: document.querySelector("#export-actions"),
  importActions: document.querySelector("#import-actions"),
  saveSettings: document.querySelector("#save-settings"),
  execute: document.querySelector("#execute"),
  continue: document.querySelector("#continue"),
  confirm: document.querySelector("#confirm"),
  openAiSettings: document.querySelector("#open-ai-settings"),
  closeAiSettings: document.querySelector("#close-ai-settings"),
  aiSettingsModal: document.querySelector("#ai-settings-modal")
};

async function init() {
  restoreAccessToken();
  bindEvents();
  await reloadData();
}

function bindEvents() {
  elements.addAction.addEventListener("click", handleAddAction);
  elements.deleteAction.addEventListener("click", handleDeleteAction);
  elements.saveActions.addEventListener("click", handleSaveActions);
  elements.exportActions.addEventListener("click", handleExportActions);
  elements.importActions.addEventListener("change", handleImportActions);
  elements.saveSettings.addEventListener("click", handleSaveSettings);
  elements.execute.addEventListener("click", () => handlePlayground("execute"));
  elements.continue.addEventListener("click", () => handlePlayground("continue"));
  elements.confirm.addEventListener("click", () => handlePlayground("confirm"));
  elements.reloadData.addEventListener("click", reloadData);
  elements.apiAccessToken.addEventListener("change", persistAccessToken);
  elements.openAiSettings.addEventListener("click", openAiSettingsModal);
  elements.closeAiSettings.addEventListener("click", closeAiSettingsModal);
  elements.aiSettingsModal
    .querySelector(".modal-backdrop")
    .addEventListener("click", closeAiSettingsModal);
}

function openAiSettingsModal() {
  elements.aiSettingsModal.classList.add("active");
}

function closeAiSettingsModal() {
  elements.aiSettingsModal.classList.remove("active");
}

async function reloadData() {
  try {
    await Promise.all([loadActions(), loadSettings()]);
    writeOutput({ status: "loaded" });
  } catch (error) {
    writeOutput({ status: "error", message: error.message });
  }
}

async function loadActions() {
  state.config = await requestJson("./api/actions");
  if (state.selectedIndex >= state.config.actions.length) {
    state.selectedIndex = Math.max(0, state.config.actions.length - 1);
  }
  renderActionList();
  renderActionForm();
}

async function loadSettings() {
  state.settings = await requestJson("./api/settings");
  renderSettingsForm();
}

function renderActionList() {
  elements.actionList.innerHTML = "";
  state.config.actions.forEach((action, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.name || `action_${index + 1}`;
    button.className = index === state.selectedIndex ? "selected" : "";
    button.addEventListener("click", () => {
      persistActionDraft();
      state.selectedIndex = index;
      renderActionList();
      renderActionForm();
    });
    item.appendChild(button);
    elements.actionList.appendChild(item);
  });
}

function renderActionForm() {
  const action = state.config.actions[state.selectedIndex] || createEmptyAction();
  elements.configVersion.value = state.config.version || "1.0.0";
  elements.actionName.value = action.name || "";
  elements.actionDescription.value = action.description || "";
  elements.actionPermission.value = action.permission || "normal";
  elements.actionEnabled.checked = action.enabled !== false;
  elements.actionTags.value = (action.tags || []).join(", ");
  elements.actionExamples.value = (action.examples || []).join("\n");
  elements.messageSuccess.value = action.messages?.success || "";
  elements.messageConfirm.value = action.messages?.confirm || "";
  elements.actionParameters.value = JSON.stringify(action.parameters || [], null, 2);
  elements.actionCache.value = stringifyOptional(action.cache);
  elements.actionWorkflow.value = stringifyOptional(action.workflow);
}

function renderSettingsForm() {
  elements.aiBaseUrl.value = state.settings.baseURL || "";
  elements.aiApiKey.value = state.settings.apiKey || "";
  elements.aiModel.value = state.settings.model || "";
  elements.aiMaxTokens.value = state.settings.maxTokens || 1024;
  elements.aiTemperature.value = state.settings.temperature ?? 0.1;
  elements.aiTimeoutMs.value = state.settings.timeoutMs || 10000;
  elements.aiMaxRetries.value = state.settings.maxRetries ?? 1;
  elements.aiAllowFallback.checked = state.settings.allowHeuristicFallback === true;
  elements.aiSystemPrompt.value = state.settings.systemPrompt || "";
}

function persistActionDraft() {
  if (!state.config.actions[state.selectedIndex]) {
    return;
  }

  const cache = parseOptionalJsonField(elements.actionCache.value);
  const workflow = parseOptionalJsonField(elements.actionWorkflow.value);

  state.config.version = elements.configVersion.value.trim() || "1.0.0";
  state.config.actions[state.selectedIndex] = {
    ...state.config.actions[state.selectedIndex],
    name: elements.actionName.value.trim(),
    description: elements.actionDescription.value.trim(),
    permission: elements.actionPermission.value,
    enabled: elements.actionEnabled.checked,
    tags: splitText(elements.actionTags.value, ","),
    examples: splitText(elements.actionExamples.value, "\n"),
    messages: {
      success: elements.messageSuccess.value.trim(),
      confirm: elements.messageConfirm.value.trim()
    },
    parameters: parseJsonField(elements.actionParameters.value, []),
    ...(cache ? { cache } : {}),
    ...(workflow ? { workflow } : {})
  };

  if (!cache) {
    delete state.config.actions[state.selectedIndex].cache;
  }
  if (!workflow) {
    delete state.config.actions[state.selectedIndex].workflow;
  }
}

function handleAddAction() {
  persistActionDraft();
  state.config.actions.push(createEmptyAction());
  state.selectedIndex = state.config.actions.length - 1;
  renderActionList();
  renderActionForm();
}

function handleDeleteAction() {
  if (state.config.actions.length === 0) {
    return;
  }
  state.config.actions.splice(state.selectedIndex, 1);
  state.selectedIndex = Math.max(0, state.selectedIndex - 1);
  renderActionList();
  renderActionForm();
}

async function handleSaveActions() {
  try {
    persistActionDraft();
    state.config = await requestJson("./api/actions", {
      method: "PUT",
      body: JSON.stringify(state.config)
    });
    renderActionList();
    renderActionForm();
    writeOutput({ status: "saved", target: "actions" });
  } catch (error) {
    writeOutput({ status: "error", message: error.message });
  }
}

function handleExportActions() {
  persistActionDraft();
  const blob = new Blob([JSON.stringify(state.config, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "actions.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function handleImportActions(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  try {
    const text = await file.text();
    state.config = JSON.parse(text);
    state.selectedIndex = 0;
    renderActionList();
    renderActionForm();
    writeOutput({ status: "imported", target: file.name });
  } catch (error) {
    writeOutput({ status: "error", message: error.message });
  }
}

async function handleSaveSettings() {
  try {
    state.settings = await requestJson("./api/settings", {
      method: "PUT",
      body: JSON.stringify({
        baseURL: elements.aiBaseUrl.value.trim(),
        apiKey: elements.aiApiKey.value.trim(),
        model: elements.aiModel.value.trim(),
        maxTokens: Number(elements.aiMaxTokens.value || 1024),
        temperature: Number(elements.aiTemperature.value || 0.1),
        timeoutMs: Number(elements.aiTimeoutMs.value || 10000),
        maxRetries: Number(elements.aiMaxRetries.value || 1),
        allowHeuristicFallback: elements.aiAllowFallback.checked,
        systemPrompt: elements.aiSystemPrompt.value.trim()
      })
    });
    renderSettingsForm();
    writeOutput({ status: "saved", target: "settings" });
    closeAiSettingsModal();
  } catch (error) {
    writeOutput({ status: "error", message: error.message });
  }
}

async function handlePlayground(mode) {
  try {
    const context = parseJsonField(elements.playContext.value, {});
    const payload = {
      input: elements.playInput.value,
      sessionId: elements.playSession.value.trim(),
      context
    };

    let result;
    if (mode === "execute") {
      result = await requestJson("./api/execute", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } else if (mode === "continue") {
      result = await requestJson("./api/continue", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } else {
      result = await requestJson("./api/confirm", {
        method: "POST",
        body: JSON.stringify({
          confirmToken: state.lastResponse?.confirmToken,
          sessionId: payload.sessionId,
          context
        })
      });
    }

    state.lastResponse = result;
    if (result.sessionId) {
      elements.playSession.value = result.sessionId;
    }
    writeOutput(result);
  } catch (error) {
    writeOutput({ status: "error", message: error.message });
  }
}

async function requestJson(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const token = elements.apiAccessToken.value.trim();
  if (token) {
    headers["X-ATAgent-Token"] = token;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || "Request failed.");
  }
  return payload;
}

function parseJsonField(raw, fallback) {
  try {
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (error) {
    writeOutput({ status: "error", message: error.message });
    throw error;
  }
}

function parseOptionalJsonField(raw) {
  return raw.trim() ? parseJsonField(raw, null) : null;
}

function splitText(raw, separator) {
  return raw
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createEmptyAction() {
  return {
    name: "",
    description: "",
    parameters: [],
    examples: [],
    messages: {},
    permission: "normal",
    enabled: true,
    tags: []
  };
}

function stringifyOptional(value) {
  return value ? JSON.stringify(value, null, 2) : "";
}

function restoreAccessToken() {
  const token = window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  elements.apiAccessToken.value = token;
}

function persistAccessToken() {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, elements.apiAccessToken.value.trim());
}

function writeOutput(payload) {
  elements.playOutput.textContent = JSON.stringify(payload, null, 2);
}

init().catch((error) => {
  writeOutput({ status: "error", message: error.message });
});

"use strict";

const { deepClone } = require("./utils");

class MemoryCacheStore {
  constructor() {
    this.items = new Map();
  }

  get(key) {
    const entry = this.items.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.items.delete(key);
      return null;
    }

    return deepClone(entry.value);
  }

  set(key, value, ttlMs) {
    const expiresAt =
      Number.isFinite(ttlMs) && ttlMs > 0 ? Date.now() + ttlMs : null;
    this.items.set(key, {
      value: deepClone(value),
      expiresAt
    });
  }

  delete(key) {
    this.items.delete(key);
  }

  clear() {
    this.items.clear();
  }
}

function buildCacheKey({ action, params = {}, context = {}, configVersion = "" }) {
  const contextKeys = action?.cache?.contextKeys || [];
  return JSON.stringify({
    action: action.name,
    configVersion,
    params: stableValue(params),
    context: stableValue(pickContext(context, contextKeys))
  });
}

function pickContext(context, keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return {};
  }

  const picked = {};
  for (const key of keys) {
    if (!key) {
      continue;
    }
    picked[key] = context ? context[key] : undefined;
  }
  return picked;
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
      }, {});
  }

  return value;
}

module.exports = {
  MemoryCacheStore,
  buildCacheKey
};

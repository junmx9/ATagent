"use strict";

const crypto = require("node:crypto");

function randomId(prefix = "id") {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function renderTemplate(template, values = {}) {
  if (!template) {
    return "";
  }
  return String(template).replace(/\{([^}]+)\}/g, (_, key) => {
    const value = values[key.trim()];
    return value === undefined || value === null ? "" : String(value);
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    error.statusCode = 400;
    error.message = "Invalid JSON body.";
    throw error;
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", contentType);
  res.end(text);
}

function normalizeBasePath(basePath) {
  if (!basePath || basePath === "/") {
    return "";
  }
  const withSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

module.exports = {
  deepClone,
  normalizeBasePath,
  randomId,
  readJsonBody,
  renderTemplate,
  sendJson,
  sendText
};

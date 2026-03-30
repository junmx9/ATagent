"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeBasePath, readJsonBody, sendJson, sendText } = require("./utils");

function createHttpHandler(agent, { basePath = "/atagent", security = {} } = {}) {
  const normalizedBase = normalizeBasePath(basePath);
  const uiDir = path.join(path.dirname(__dirname), "ui");
  const auth = normalizeAuthConfig(security.auth);
  const rateLimiter = createRateLimiter(security.rateLimit);

  return async (req, res, next) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const relativePath = stripBasePath(url.pathname, normalizedBase);
      if (relativePath === null) {
        if (typeof next === "function") {
          next();
          return;
        }
        sendJson(res, 404, { message: "Not Found" });
        return;
      }

      const route = {
        method: req.method,
        path: relativePath,
        isApi: relativePath.startsWith("/api/"),
        isHealth: relativePath === "/api/health"
      };

      const authResult = await authorizeRequest(req, route, auth);
      if (!authResult.allowed) {
        sendJson(res, 401, {
          status: "error",
          message: authResult.message || "Unauthorized"
        });
        return;
      }

      if (!rateLimiter.allow(req, route)) {
        sendJson(res, 429, {
          status: "error",
          message: "Too many requests. Please try again later."
        });
        return;
      }

      if (req.method === "GET" && (relativePath === "/" || relativePath === "")) {
        return serveFile(res, path.join(uiDir, "index.html"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && relativePath === "/app.js") {
        return serveFile(
          res,
          path.join(uiDir, "app.js"),
          "application/javascript; charset=utf-8"
        );
      }
      if (req.method === "GET" && relativePath === "/style.css") {
        return serveFile(res, path.join(uiDir, "style.css"), "text/css; charset=utf-8");
      }

      if (req.method === "GET" && relativePath === "/api/actions") {
        sendJson(res, 200, agent.getActionsConfig());
        return;
      }
      if (req.method === "PUT" && relativePath === "/api/actions") {
        const body = await readJsonBody(req);
        const config = agent.saveActions(body);
        sendJson(res, 200, config);
        return;
      }
      if (req.method === "GET" && relativePath === "/api/settings") {
        sendJson(res, 200, agent.getAiSettings());
        return;
      }
      if (req.method === "PUT" && relativePath === "/api/settings") {
        const body = await readJsonBody(req);
        const settings = agent.saveAiSettings(body);
        sendJson(res, 200, settings);
        return;
      }
      if (req.method === "POST" && relativePath === "/api/execute") {
        const body = await readJsonBody(req);
        const result = await agent.execute(body.input, {
          context: body.context || {},
          sessionId: body.sessionId || null,
          mode: body.mode
        });
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "POST" && relativePath === "/api/continue") {
        const body = await readJsonBody(req);
        const result = await agent.continue(body.input, {
          sessionId: body.sessionId || null,
          context: body.context || {}
        });
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "POST" && relativePath === "/api/confirm") {
        const body = await readJsonBody(req);
        const result = await agent.confirm(body.confirmToken, {
          sessionId: body.sessionId || null,
          context: body.context || {}
        });
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "GET" && relativePath === "/api/health") {
        sendJson(res, 200, {
          status: "ok",
          version: agent.getActionsConfig().version
        });
        return;
      }

      sendJson(res, 404, { message: "Not Found" });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(res, statusCode, {
        status: "error",
        message: error.message
      });
    }
  };
}

function stripBasePath(pathname, basePath) {
  if (!basePath) {
    return pathname;
  }
  if (pathname === basePath) {
    return "/";
  }
  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length);
  }
  if (
    pathname === "/" ||
    pathname.startsWith("/api/") ||
    pathname === "/app.js" ||
    pathname === "/style.css"
  ) {
    return pathname;
  }
  return null;
}

function serveFile(res, filePath, contentType) {
  const content = fs.readFileSync(filePath, "utf8");
  sendText(res, 200, content, contentType);
}

function normalizeAuthConfig(auth) {
  const config = auth && typeof auth === "object" ? auth : {};
  return {
    enabled: Boolean(config.token || typeof config.validate === "function"),
    token: String(config.token || "").trim(),
    validate: typeof config.validate === "function" ? config.validate : null,
    headerName: String(config.headerName || "x-atagent-token").trim().toLowerCase(),
    protectUi: config.protectUi === true
  };
}

async function authorizeRequest(req, route, auth) {
  if (!auth.enabled) {
    return { allowed: true };
  }

  if (!route.isApi && !auth.protectUi) {
    return { allowed: true };
  }

  if (route.isHealth) {
    return { allowed: true };
  }

  const token = readRequestToken(req, auth.headerName);
  if (auth.validate) {
    const decision = await auth.validate({
      request: req,
      route,
      token
    });
    if (decision === true || decision?.allowed === true) {
      return { allowed: true };
    }
    return {
      allowed: false,
      message: decision?.message || "Unauthorized"
    };
  }

  return {
    allowed: token === auth.token,
    message: "Unauthorized"
  };
}

function readRequestToken(req, headerName) {
  const direct = req.headers[headerName];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return "";
}

function createRateLimiter(rateLimit) {
  const config = normalizeRateLimitConfig(rateLimit);
  const records = new Map();

  return {
    allow(req, route) {
      if (!config.enabled || route.isHealth) {
        return true;
      }

      const now = Date.now();
      pruneExpiredRecords(records, now, config.windowMs);

      const key = `${getClientKey(req)}:${route.path}`;
      const entry = records.get(key);
      if (!entry || now >= entry.resetAt) {
        records.set(key, {
          count: 1,
          resetAt: now + config.windowMs
        });
        return true;
      }

      if (entry.count >= config.max) {
        return false;
      }

      entry.count += 1;
      records.set(key, entry);
      return true;
    }
  };
}

function normalizeRateLimitConfig(rateLimit) {
  const config = rateLimit && typeof rateLimit === "object" ? rateLimit : {};
  const max = Number(config.max);
  const windowMs = Number(config.windowMs);

  return {
    enabled: Number.isFinite(max) && max > 0,
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 0,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 60 * 1000
  };
}

function pruneExpiredRecords(records, now, windowMs) {
  if (records.size <= 1000) {
    return;
  }
  for (const [key, entry] of records.entries()) {
    if (entry.resetAt <= now - windowMs) {
      records.delete(key);
    }
  }
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

module.exports = {
  createHttpHandler
};

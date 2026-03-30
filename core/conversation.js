"use strict";

const { deepClone, randomId } = require("./utils");

class MemoryStateStore {
  constructor() {
    this.records = new Map();
  }

  get(key) {
    if (!this.records.has(key)) {
      return null;
    }
    return clone(this.records.get(key));
  }

  set(key, value) {
    this.records.set(key, clone(value));
  }

  delete(key) {
    this.records.delete(key);
  }

  clear() {
    this.records.clear();
  }
}

class ConversationStore {
  constructor({
    ttlMs = 30 * 60 * 1000,
    confirmationTtlMs = 10 * 60 * 1000,
    sessionStore,
    confirmationStore
  } = {}) {
    this.ttlMs = ttlMs;
    this.confirmationTtlMs = confirmationTtlMs;
    this.sessions = sessionStore || new MemoryStateStore();
    this.confirmations = confirmationStore || new MemoryStateStore();
  }

  async createClarification(sessionId, payload) {
    const id = sessionId || randomId("session");
    await this.sessions.set(id, {
      kind: "clarify",
      ...clone(payload),
      updatedAt: Date.now()
    });
    return id;
  }

  async getSession(sessionId) {
    const session = await this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (Date.now() - session.updatedAt > this.ttlMs) {
      await this.sessions.delete(sessionId);
      return null;
    }
    return clone(session);
  }

  async updateSession(sessionId, patch) {
    const existing = await this.sessions.get(sessionId);
    if (!existing) {
      return null;
    }
    const next = {
      ...existing,
      ...clone(patch),
      updatedAt: Date.now()
    };
    await this.sessions.set(sessionId, next);
    return clone(next);
  }

  async clearSession(sessionId) {
    await this.sessions.delete(sessionId);
  }

  async createPlanSession(planId, payload) {
    const id = planId || randomId("plan");
    await this.sessions.set(id, {
      kind: "plan",
      id,
      ...clone(payload),
      updatedAt: Date.now()
    });
    return id;
  }

  async getPlanSession(planId) {
    const session = await this.getSession(planId);
    if (!session || session.kind !== "plan") {
      return null;
    }
    return session;
  }

  async updatePlanSession(planId, patch) {
    const session = await this.getSession(planId);
    if (!session || session.kind !== "plan") {
      return null;
    }
    return this.updateSession(planId, patch);
  }

  async clearPlanSession(planId) {
    await this.clearSession(planId);
  }

  async createConfirmation(payload) {
    const token = randomId("confirm");
    await this.confirmations.set(token, {
      ...clone(payload),
      createdAt: Date.now()
    });
    return token;
  }

  async consumeConfirmation(token) {
    const confirmation = await this.confirmations.get(token);
    if (!confirmation) {
      return null;
    }
    await this.confirmations.delete(token);
    if (Date.now() - confirmation.createdAt > this.confirmationTtlMs) {
      return null;
    }
    return clone(confirmation);
  }
}

function clone(value) {
  return value === undefined ? undefined : deepClone(value);
}

module.exports = {
  ConversationStore,
  MemoryStateStore
};

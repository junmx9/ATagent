"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { deepClone } = require("./utils");

const FILE_QUEUES = new Map();

class JsonFileStoreBase {
  constructor(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new TypeError("A JSON file path is required.");
    }
    this.filePath = path.resolve(filePath);
  }

  async readRecords() {
    return this.runExclusive(async () => this.readRecordsUnsafe());
  }

  async updateRecords(mutator) {
    return this.runExclusive(async () => {
      const records = await this.readRecordsUnsafe();
      const nextRecords = (await mutator(records)) || records;
      await this.writeRecordsUnsafe(nextRecords);
      return nextRecords;
    });
  }

  async runExclusive(task) {
    const current = FILE_QUEUES.get(this.filePath) || Promise.resolve();
    const next = current.then(task, task);
    FILE_QUEUES.set(
      this.filePath,
      next.catch(() => {})
    );
    return next;
  }

  async readRecordsUnsafe() {
    await ensureJsonFile(this.filePath);
    const content = await fs.promises.readFile(this.filePath, "utf8");
    if (!content.trim()) {
      return {};
    }

    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(
        `JSON store "${this.filePath}" must contain a top-level object.`
      );
    }
    return parsed;
  }

  async writeRecordsUnsafe(records) {
    const normalized =
      records && typeof records === "object" && !Array.isArray(records) ? records : {};
    const tempPath = `${this.filePath}.tmp`;
    const content = `${JSON.stringify(normalized, null, 2)}\n`;

    await fs.promises.writeFile(tempPath, content, "utf8");
    await fs.promises.rename(tempPath, this.filePath);
  }
}

class JsonFileStateStore extends JsonFileStoreBase {
  async get(key) {
    const records = await this.readRecords();
    if (!Object.prototype.hasOwnProperty.call(records, key)) {
      return null;
    }
    return clone(records[key]);
  }

  async set(key, value) {
    await this.updateRecords((records) => {
      records[key] = clone(value);
      return records;
    });
  }

  async delete(key) {
    await this.updateRecords((records) => {
      delete records[key];
      return records;
    });
  }
}

class JsonFileCacheStore extends JsonFileStoreBase {
  async get(key) {
    return this.runExclusive(async () => {
      const records = await this.readRecordsUnsafe();
      const changed = pruneExpiredEntries(records);
      const entry = records[key];

      if (!entry) {
        if (changed) {
          await this.writeRecordsUnsafe(records);
        }
        return null;
      }

      if (changed) {
        await this.writeRecordsUnsafe(records);
      }

      return clone(entry.value);
    });
  }

  async set(key, value, ttlMs) {
    await this.updateRecords((records) => {
      pruneExpiredEntries(records);
      records[key] = {
        value: clone(value),
        expiresAt:
          Number.isFinite(ttlMs) && ttlMs > 0 ? Date.now() + ttlMs : null
      };
      return records;
    });
  }

  async delete(key) {
    await this.updateRecords((records) => {
      delete records[key];
      return records;
    });
  }
}

async function ensureJsonFile(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch {
    await fs.promises.writeFile(filePath, "{}\n", "utf8");
  }
}

function pruneExpiredEntries(records) {
  let changed = false;
  const now = Date.now();

  for (const [key, entry] of Object.entries(records)) {
    if (
      entry &&
      typeof entry === "object" &&
      Object.prototype.hasOwnProperty.call(entry, "expiresAt") &&
      entry.expiresAt !== null &&
      entry.expiresAt <= now
    ) {
      delete records[key];
      changed = true;
    }
  }

  return changed;
}

function clone(value) {
  return value === undefined ? undefined : deepClone(value);
}

module.exports = {
  JsonFileStateStore,
  JsonFileCacheStore
};

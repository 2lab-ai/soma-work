"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryFileStore = void 0;
/**
 * Standalone MemoryStore implementation using file I/O.
 * No dependency on app-level modules (Logger, env-paths, etc.).
 * Used by MCP servers that run as separate processes.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ENTRY_DELIMITER = '\n§\n';
const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;
function isSafeSegment(s) {
    return /^[A-Za-z0-9_-]+$/.test(s);
}
function charCount(entries) {
    if (entries.length === 0)
        return 0;
    return entries.join(ENTRY_DELIMITER).length;
}
class MemoryFileStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    filePath(user, target) {
        if (!isSafeSegment(user))
            throw new Error(`Invalid userId: ${user}`);
        const fileName = target === 'memory' ? 'MEMORY.md' : 'USER.md';
        return path.join(this.dataDir, user, fileName);
    }
    charLimit(target) {
        return target === 'memory' ? DEFAULT_MEMORY_CHAR_LIMIT : DEFAULT_USER_CHAR_LIMIT;
    }
    readEntries(user, target) {
        const fp = this.filePath(user, target);
        try {
            if (!fs.existsSync(fp))
                return [];
            const raw = fs.readFileSync(fp, 'utf-8');
            if (!raw.trim())
                return [];
            return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter((e) => e.length > 0);
        }
        catch {
            return [];
        }
    }
    writeEntries(user, target, entries) {
        const fp = this.filePath(user, target);
        const dir = path.dirname(fp);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fp, entries.join(ENTRY_DELIMITER), 'utf-8');
    }
    addMemory(user, target, content) {
        const trimmed = content.trim();
        if (!trimmed)
            return { ok: false, message: 'Empty content' };
        const entries = this.readEntries(user, target);
        if (entries.some((e) => e === trimmed))
            return { ok: false, message: 'Duplicate entry already exists' };
        const next = [...entries, trimmed];
        const limit = this.charLimit(target);
        if (charCount(next) > limit) {
            return { ok: false, message: `Would exceed char limit (${charCount(entries)}/${limit} used). Remove old entries first.` };
        }
        this.writeEntries(user, target, next);
        return { ok: true, message: 'Entry added' };
    }
    replaceMemory(user, target, oldText, content) {
        const trimmed = content.trim();
        if (!trimmed)
            return { ok: false, message: 'Replacement content is empty' };
        const entries = this.readEntries(user, target);
        const matches = entries.filter((e) => e.includes(oldText));
        if (matches.length === 0)
            return { ok: false, message: `No entry matching "${oldText}" found` };
        if (matches.length > 1 && new Set(matches).size > 1) {
            return { ok: false, message: `Multiple entries match "${oldText}". Be more specific.` };
        }
        const idx = entries.findIndex((e) => e.includes(oldText));
        const updated = [...entries];
        updated[idx] = trimmed;
        const limit = this.charLimit(target);
        if (charCount(updated) > limit)
            return { ok: false, message: `Replacement would exceed char limit (${limit})` };
        this.writeEntries(user, target, updated);
        return { ok: true, message: 'Entry replaced' };
    }
    removeMemory(user, target, oldText) {
        const entries = this.readEntries(user, target);
        const matches = entries.filter((e) => e.includes(oldText));
        if (matches.length === 0)
            return { ok: false, message: `No entry matching "${oldText}" found` };
        if (matches.length > 1 && new Set(matches).size > 1) {
            return { ok: false, message: `Multiple entries match "${oldText}". Be more specific.` };
        }
        const idx = entries.findIndex((e) => e.includes(oldText));
        const updated = [...entries];
        updated.splice(idx, 1);
        this.writeEntries(user, target, updated);
        return { ok: true, message: 'Entry removed' };
    }
    loadMemory(user, target) {
        const entries = this.readEntries(user, target);
        const limit = this.charLimit(target);
        const total = charCount(entries);
        return { entries, charLimit: limit, totalChars: total, percentUsed: limit > 0 ? Math.round((total / limit) * 100) : 0 };
    }
}
exports.MemoryFileStore = MemoryFileStore;
//# sourceMappingURL=memory-file-store.js.map
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
exports.SkillFileStore = void 0;
/**
 * Standalone SkillStore implementation using file I/O.
 * No dependency on app-level modules (Logger, env-paths, etc.).
 * Used by MCP servers that run as separate processes.
 * Mirrors memory-file-store.ts pattern.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const MAX_SKILL_SIZE = 10 * 1024; // 10KB
const MAX_SKILLS_PER_USER = 50;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
function isSafeSegment(s) {
    return /^[A-Za-z0-9_-]+$/.test(s);
}
function extractDescription(content) {
    const match = content.match(/^---\s*\n[\s\S]*?description:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/);
    return match?.[1]?.trim() ?? '';
}
class SkillFileStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    skillsDir(user) {
        if (!isSafeSegment(user))
            throw new Error(`Invalid userId: ${user}`);
        return path.join(this.dataDir, user, 'skills');
    }
    skillPath(user, name) {
        return path.join(this.skillsDir(user), name, 'SKILL.md');
    }
    listSkills(user) {
        const dir = this.skillsDir(user);
        if (!fs.existsSync(dir))
            return [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const skills = [];
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const fp = path.join(dir, entry.name, 'SKILL.md');
                if (!fs.existsSync(fp))
                    continue;
                skills.push({ name: entry.name, description: extractDescription(fs.readFileSync(fp, 'utf-8')) });
            }
            return skills.sort((a, b) => a.name.localeCompare(b.name));
        }
        catch {
            return [];
        }
    }
    createSkill(user, name, content) {
        if (!SKILL_NAME_PATTERN.test(name) || !isSafeSegment(name)) {
            return { ok: false, message: `Invalid skill name "${name}". Use kebab-case.` };
        }
        const trimmed = content.trim();
        if (!trimmed)
            return { ok: false, message: 'Skill content is empty.' };
        if (Buffer.byteLength(trimmed, 'utf-8') > MAX_SKILL_SIZE) {
            return { ok: false, message: `Skill exceeds max size (${MAX_SKILL_SIZE / 1024}KB).` };
        }
        if (this.listSkills(user).length >= MAX_SKILLS_PER_USER) {
            return { ok: false, message: `Maximum ${MAX_SKILLS_PER_USER} skills reached.` };
        }
        const fp = this.skillPath(user, name);
        if (fs.existsSync(fp))
            return { ok: false, message: `Skill "${name}" already exists. Use update.` };
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, trimmed, 'utf-8');
        return { ok: true, message: `Skill "${name}" created.` };
    }
    updateSkill(user, name, content) {
        if (!SKILL_NAME_PATTERN.test(name) || !isSafeSegment(name)) {
            return { ok: false, message: `Invalid skill name "${name}". Use kebab-case.` };
        }
        const trimmed = content.trim();
        if (!trimmed)
            return { ok: false, message: 'Skill content is empty.' };
        if (Buffer.byteLength(trimmed, 'utf-8') > MAX_SKILL_SIZE) {
            return { ok: false, message: `Skill exceeds max size (${MAX_SKILL_SIZE / 1024}KB).` };
        }
        const fp = this.skillPath(user, name);
        if (!fs.existsSync(fp))
            return { ok: false, message: `Skill "${name}" not found. Use create.` };
        fs.writeFileSync(fp, trimmed, 'utf-8');
        return { ok: true, message: `Skill "${name}" updated.` };
    }
    deleteSkill(user, name) {
        if (!SKILL_NAME_PATTERN.test(name) || !isSafeSegment(name)) {
            return { ok: false, message: `Invalid skill name "${name}".` };
        }
        const skillDir = path.join(this.skillsDir(user), name);
        if (!fs.existsSync(skillDir))
            return { ok: false, message: `Skill "${name}" not found.` };
        fs.rmSync(skillDir, { recursive: true, force: true });
        return { ok: true, message: `Skill "${name}" deleted.` };
    }
}
exports.SkillFileStore = SkillFileStore;
//# sourceMappingURL=skill-file-store.js.map
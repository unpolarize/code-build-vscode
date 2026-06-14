// Memory inventory scanner — mirror of code-sessions's memoryView.ts
// scan functions so CB can surface the same "N memory entries"
// counter in its header without depending on the CS extension.
//
// Kept deliberately pure (no vscode import) so it can be exercised
// from unit tests + reused by future CB views (live memory sidebar
// per memory-map-spec phase 2). When the agent-memory-core package
// stabilises we'll switch both extensions over to it; until then the
// duplication is small (one function pair) and self-contained.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface MemorySource {
  id: string;
  label: string;
  description: string;
  absPath: string;
  scope: "workspace" | "project" | "user" | "global";
  provider: "claude" | "codex" | "grok" | "auto" | "shared";
  entryCount: number;
  exists: boolean;
  empty?: boolean;
}

function countH2Sections(text: string): number {
  const lines = text.split("\n");
  let inFence = false;
  let count = 0;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+\S/.test(line)) count += 1;
  }
  return count;
}

function readEntries(absPath: string): { content: string; count: number } | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    if (stat.size > 2 * 1024 * 1024) return { content: "", count: 1 };
    const content = fs.readFileSync(absPath, "utf8");
    const h2 = countH2Sections(content);
    const count = h2 > 0 ? h2 : content.trim().length > 200 ? 1 : 0;
    return { content, count };
  } catch {
    return null;
  }
}

function countCodexMemoriesDir(dir: string): number {
  let total = 0;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
    const walk = (cur: string) => {
      for (const name of fs.readdirSync(cur)) {
        const p = path.join(cur, name);
        try {
          const s = fs.statSync(p);
          if (s.isDirectory()) walk(p);
          else if (s.isFile() && /\.(md|markdown|txt)$/i.test(name)) total += 1;
        } catch {
          /* skip */
        }
      }
    };
    walk(dir);
  } catch {
    /* ignore */
  }
  return total;
}

function dashEncodeWorkspace(cwd: string): string {
  return cwd.replace(/\//g, "-").replace(/^-/, "-").replace(/\.$/, "");
}

export function scanMemorySources(workspaceRoots: string[]): MemorySource[] {
  const home = os.homedir();
  const sources: MemorySource[] = [];

  for (const ws of workspaceRoots) {
    const wsName = path.basename(ws);
    const candidates: Array<{
      file: string;
      label: string;
      provider: MemorySource["provider"];
    }> = [
      { file: "CLAUDE.md", label: "CLAUDE.md", provider: "claude" },
      { file: "CLAUDE.local.md", label: "CLAUDE.local.md", provider: "claude" },
      { file: "AGENTS.md", label: "AGENTS.md", provider: "shared" },
      { file: "MEMORY.md", label: "MEMORY.md", provider: "shared" },
      { file: ".claude/CLAUDE.md", label: ".claude/CLAUDE.md", provider: "claude" },
    ];
    for (const c of candidates) {
      const abs = path.join(ws, c.file);
      const read = readEntries(abs);
      sources.push({
        id: `ws:${ws}:${c.file}`,
        label: c.label,
        description: `${wsName} · ${c.provider}`,
        absPath: abs,
        scope: "workspace",
        provider: c.provider,
        entryCount: read?.count ?? 0,
        exists: read !== null,
        empty: read !== null && read.count === 0,
      });
    }
    const dotClaude = path.join(ws, ".claude");
    for (const sub of ["rules", "commands"]) {
      const subDir = path.join(dotClaude, sub);
      try {
        if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
          const entries = fs.readdirSync(subDir).filter((n) => /\.(md|markdown)$/i.test(n));
          sources.push({
            id: `ws:${ws}:.claude/${sub}`,
            label: `.claude/${sub}/`,
            description: `${wsName} · ${entries.length}`,
            absPath: subDir,
            scope: "workspace",
            provider: "claude",
            entryCount: entries.length,
            exists: true,
            empty: entries.length === 0,
          });
        }
      } catch {
        /* ignore */
      }
    }
    const autoPath = path.join(
      home,
      ".claude",
      "projects",
      dashEncodeWorkspace(ws),
      "memory",
      "MEMORY.md",
    );
    const autoRead = readEntries(autoPath);
    if (autoRead !== null) {
      sources.push({
        id: `auto:${ws}`,
        label: "auto-memory (~/.claude/projects)",
        description: `${wsName} · auto`,
        absPath: autoPath,
        scope: "project",
        provider: "auto",
        entryCount: autoRead.count,
        exists: true,
        empty: autoRead.count === 0,
      });
    }
  }

  const userCandidates: Array<{
    file: string;
    label: string;
    provider: MemorySource["provider"];
    scope: MemorySource["scope"];
  }> = [
    { file: path.join(home, ".claude", "CLAUDE.md"), label: "~/.claude/CLAUDE.md", provider: "claude", scope: "user" },
    { file: path.join(home, ".claude", "MEMORY.md"), label: "~/.claude/MEMORY.md", provider: "claude", scope: "user" },
    { file: path.join(home, ".codex", "AGENTS.md"), label: "~/.codex/AGENTS.md", provider: "codex", scope: "user" },
    { file: path.join(home, ".grok", "AGENTS.md"), label: "~/.grok/AGENTS.md", provider: "grok", scope: "user" },
  ];
  for (const c of userCandidates) {
    const read = readEntries(c.file);
    sources.push({
      id: `user:${c.file}`,
      label: c.label,
      description: c.provider,
      absPath: c.file,
      scope: c.scope,
      provider: c.provider,
      entryCount: read?.count ?? 0,
      exists: read !== null,
      empty: read !== null && read.count === 0,
    });
  }
  const codexMemDir = path.join(home, ".codex", "memories");
  const codexCount = countCodexMemoriesDir(codexMemDir);
  if (codexCount > 0 || fs.existsSync(codexMemDir)) {
    sources.push({
      id: `user:codex-memories`,
      label: "~/.codex/memories/",
      description: `codex · ${codexCount}`,
      absPath: codexMemDir,
      scope: "user",
      provider: "codex",
      entryCount: codexCount,
      exists: true,
      empty: codexCount === 0,
    });
  }

  return sources;
}

export interface MemoryTotals {
  totalEntries: number;
  totalFiles: number;
  byProvider: Record<string, number>;
  byScope: Record<string, number>;
}
export function summariseSources(sources: MemorySource[]): MemoryTotals {
  const t: MemoryTotals = {
    totalEntries: 0,
    totalFiles: 0,
    byProvider: {},
    byScope: {},
  };
  for (const s of sources) {
    if (!s.exists) continue;
    t.totalFiles += 1;
    t.totalEntries += s.entryCount;
    t.byProvider[s.provider] = (t.byProvider[s.provider] ?? 0) + s.entryCount;
    t.byScope[s.scope] = (t.byScope[s.scope] ?? 0) + s.entryCount;
  }
  return t;
}

/**
 * Pi target.
 *
 * Pi has a first-class `before_agent_start` extension event. We use it to run
 * CodeGraph's existing `prompt-hook` gate and inject verified graph context
 * before the model starts. This avoids relying on small/local models to decide
 * to call an MCP or shell tool while keeping non-structural prompts a zero-cost
 * no-op.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

export const PI_EXTENSION_START = '// CODEGRAPH_FRONTLOAD_START';
export const PI_EXTENSION_END = '// CODEGRAPH_FRONTLOAD_END';

/** Entire generated extension. Markers make upgrades and uninstall surgical. */
export const PI_EXTENSION = `${PI_EXTENSION_START}
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_CONTEXT_BYTES = 20_000;
const HOOK_TIMEOUT_MS = 30_000;

function frontload(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "codegraph.cmd" : "codegraph";
    const child = spawn(command, ["prompt-hook"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value = "") => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      child.kill();
      finish();
    }, HOOK_TIMEOUT_MS);

    child.on("error", () => finish());
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < MAX_CONTEXT_BYTES) {
        output += chunk.toString("utf8", 0, MAX_CONTEXT_BYTES - output.length);
      }
    });
    child.on("close", (code) => finish(code === 0 ? output.trim() : ""));
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ prompt, cwd }));
  });
}

export default function codegraphFrontload(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const context = await frontload(event.prompt, ctx.cwd);
    if (!context) return;
    return {
      message: {
        customType: "codegraph-context",
        content: context,
        display: false,
      },
    };
  });
}
${PI_EXTENSION_END}`;

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.pi', 'agent');
}

function instructionsPath(loc: Location): string {
  return loc === 'global' ? path.join(agentDir(), 'AGENTS.md') : path.join(process.cwd(), 'AGENTS.md');
}

function extensionPath(loc: Location): string {
  return loc === 'global'
    ? path.join(agentDir(), 'extensions', 'codegraph-frontload.ts')
    : path.join(process.cwd(), '.pi', 'extensions', 'codegraph-frontload.ts');
}

function hasMarker(file: string, marker: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

function writeExtension(loc: Location): WriteResult['files'][number] {
  const file = extensionPath(loc);
  if (!fs.existsSync(file)) {
    atomicWriteFileSync(file, PI_EXTENSION + '\n');
    return { path: file, action: 'created' };
  }

  const current = fs.readFileSync(file, 'utf8');
  if (current === PI_EXTENSION + '\n') return { path: file, action: 'unchanged' };

  const start = current.indexOf(PI_EXTENSION_START);
  const end = current.indexOf(PI_EXTENSION_END);
  if (start === -1 || end < start) {
    return { path: file, action: 'kept' };
  }

  const updated = current.slice(0, start) + PI_EXTENSION + current.slice(end + PI_EXTENSION_END.length);
  atomicWriteFileSync(file, updated);
  return { path: file, action: 'updated' };
}

function removeExtension(loc: Location): WriteResult['files'][number] {
  const file = extensionPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const current = fs.readFileSync(file, 'utf8');
  const start = current.indexOf(PI_EXTENSION_START);
  const end = current.indexOf(PI_EXTENSION_END, start);
  if (start === -1) return { path: file, action: 'not-found' };
  // A partial/corrupt marker is not proof that we own the whole file. Preserve
  // it instead of guessing and potentially deleting user code.
  if (end < start) return { path: file, action: 'kept' };
  const remaining = (current.slice(0, start) + current.slice(end + PI_EXTENSION_END.length)).trim();
  if (!remaining) fs.unlinkSync(file);
  else atomicWriteFileSync(file, remaining + '\n');
  return { path: file, action: 'removed' };
}

class PiTarget implements AgentTarget {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi';
  readonly docsUrl = 'https://github.com/earendil-works/pi';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const extension = extensionPath(loc);
    const instructions = instructionsPath(loc);
    return {
      installed: loc === 'global' ? fs.existsSync(agentDir()) : fs.existsSync(path.join(process.cwd(), '.pi')),
      alreadyConfigured:
        hasMarker(extension, PI_EXTENSION_START) && hasMarker(instructions, CODEGRAPH_SECTION_START),
      configPath: extension,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const extension = writeExtension(loc);
    const files = [extension, upsertInstructionsEntry(instructionsPath(loc))];
    const notes = extension.action === 'kept'
      ? [`Kept existing ${extension.path}; move it aside to install deterministic CodeGraph front-loading.`]
      : ['Restart Pi or run /reload to activate deterministic CodeGraph front-loading.'];
    return { files, notes };
  }

  uninstall(loc: Location): WriteResult {
    return {
      files: [
        removeExtension(loc),
        {
          path: instructionsPath(loc),
          action: removeMarkedSection(
            instructionsPath(loc),
            CODEGRAPH_SECTION_START,
            CODEGRAPH_SECTION_END,
          ),
        },
      ],
    };
  }

  printConfig(loc: Location): string {
    return `# Save as ${extensionPath(loc)}\n\n${PI_EXTENSION}\n`;
  }

  describePaths(loc: Location): string[] {
    return [extensionPath(loc), instructionsPath(loc)];
  }
}

export const piTarget: AgentTarget = new PiTarget();

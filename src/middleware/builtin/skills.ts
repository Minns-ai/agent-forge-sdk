import type {
  Middleware,
  MiddlewareContext,
  PipelineState,
  StateUpdate,
} from "../types.js";
import type { ToolDefinition, ToolResult } from "../../types.js";
import type { BackendProtocol } from "../backend/protocol.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Metadata parsed from SKILL.md YAML frontmatter.
 * Follows the Agent Skills specification (https://agentskills.io/specification).
 */
export interface SkillMetadata {
  /** Skill identifier (1-64 chars, lowercase alphanumeric + hyphens) */
  name: string;
  /** What the skill does (1-1024 chars) */
  description: string;
  /** Backend path to the SKILL.md file */
  path: string;
  /** License name or reference */
  license?: string;
  /** Environment requirements */
  compatibility?: string;
  /** Arbitrary key-value metadata */
  metadata: Record<string, string>;
  /** Tool names the skill recommends using */
  allowedTools: string[];
}

/**
 * Configuration for the skills middleware.
 */
export interface SkillsConfig {
  /**
   * Backend for loading skill files.
   * Can be a StateBackend, FilesystemBackend, or any BackendProtocol implementation.
   */
  backend: BackendProtocol;

  /**
   * Source directories to scan for skills.
   * Later sources override earlier ones when skills have the same name.
   *
   * Example: ["/skills/base/", "/skills/user/", "/skills/project/"]
   */
  sources: string[];
}

// ─── YAML Frontmatter Parser ─────────────────────────────────────────────────

/**
 * Parse simple YAML frontmatter from a SKILL.md file.
 * Handles the common subset: key: value pairs, no nested objects.
 * Falls back gracefully on complex YAML.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split("\n");

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && value) {
      frontmatter[key] = value;
    }
  }

  return Object.keys(frontmatter).length > 0 ? frontmatter : null;
}

/**
 * Validate skill name per Agent Skills specification.
 */
function isValidSkillName(name: string): boolean {
  if (!name || name.length > 64) return false;
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) return false;
  return /^[a-z0-9-]+$/.test(name);
}

/**
 * Parse a SKILL.md file content into SkillMetadata.
 */
function parseSkillMetadata(content: string, path: string, directoryName: string): SkillMetadata | null {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) return null;

  const name = frontmatter.name;
  const description = frontmatter.description;

  if (!name || !description) return null;

  // Validate name
  if (!isValidSkillName(name)) {
    // Warn but continue (backward compatibility)
  }

  // Parse allowed-tools (space-delimited string)
  const allowedTools = frontmatter["allowed-tools"]
    ? frontmatter["allowed-tools"].split(/\s+/).filter(Boolean)
    : [];

  // Extract metadata (any key not in the standard set)
  const standardKeys = new Set(["name", "description", "license", "compatibility", "allowed-tools"]);
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!standardKeys.has(key)) {
      metadata[key] = value;
    }
  }

  return {
    name,
    description: description.slice(0, 1024),
    path,
    license: frontmatter.license,
    compatibility: frontmatter.compatibility?.slice(0, 500),
    metadata,
    allowedTools,
  };
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

function createLoadSkillTool(
  backend: BackendProtocol,
  getSkills: () => SkillMetadata[],
): ToolDefinition {
  return {
    name: "load_skill",
    description: "Load the full instructions for a skill by name. Use when you need detailed guidance for a task that matches a skill's domain.",
    parameters: {
      skill_name: {
        type: "string",
        description: "The name of the skill to load (from the skills list in the system prompt)",
      },
    },
    async execute(params): Promise<ToolResult> {
      const skills = getSkills();
      const skill = skills.find((s) => s.name === params.skill_name);

      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        return {
          success: false,
          error: `Skill "${params.skill_name}" not found. Available skills: ${available || "none"}`,
        };
      }

      // Read full SKILL.md content
      const result = await backend.read(skill.path);
      if (!result.content) {
        return {
          success: false,
          error: `Failed to load skill "${params.skill_name}": ${result.error}`,
        };
      }

      // Remove frontmatter from content (return just the instructions)
      let instructions = result.content;
      const frontmatterEnd = instructions.indexOf("---\n", 4);
      if (frontmatterEnd !== -1) {
        instructions = instructions.slice(frontmatterEnd + 4).trim();
      }

      return {
        success: true,
        result: {
          name: skill.name,
          description: skill.description,
          instructions,
          allowedTools: skill.allowedTools.length > 0 ? skill.allowedTools : undefined,
        },
      };
    },
  };
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SKILLS_SYSTEM_PROMPT_HEADER = `

## Skills System

You have access to a skills library that provides specialized capabilities and domain knowledge.

**Available Skills:**

`;

const SKILLS_SYSTEM_PROMPT_FOOTER = `

**How to Use Skills (Progressive Disclosure):**

Skills follow a progressive disclosure pattern — you see their name and description above, but only read full instructions when needed:

1. **Recognize when a skill applies**: Check if the user's task matches a skill's description
2. **Load the skill**: Use the \`load_skill\` tool with the skill name
3. **Follow the instructions**: The loaded content contains step-by-step workflows and best practices
4. **Use recommended tools**: Skills may specify which tools to use

When in doubt, check if a skill exists for the task — skills make you more capable and consistent.`;

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * SkillsMiddleware — progressive disclosure of specialized capabilities.
 *
 * ## How it works
 *
 * 1. On startup, scans configured source directories for SKILL.md files
 * 2. Parses YAML frontmatter to extract metadata (name, description)
 * 3. Injects a skill catalog into the system prompt (just names + descriptions)
 * 4. Provides a `load_skill` tool for loading full instructions on demand
 *
 * This keeps the system prompt lean while giving the agent access to
 * deep domain knowledge when needed.
 *
 * ## Skill structure
 *
 * ```
 * /skills/user/web-research/
 * ├── SKILL.md          # Required: YAML frontmatter + markdown instructions
 * └── helper.py         # Optional: supporting files
 * ```
 *
 * SKILL.md format:
 * ```markdown
 * ---
 * name: web-research
 * description: Structured approach to conducting thorough web research
 * license: MIT
 * allowed-tools: web_search fetch_url
 * ---
 *
 * # Web Research Skill
 *
 * ## When to Use
 * - User asks you to research a topic
 * ...
 * ```
 *
 * ## Source layering
 *
 * Skills from later sources override earlier ones with the same name:
 * ```ts
 * sources: ["/skills/base/", "/skills/user/", "/skills/project/"]
 * // project/ skills override user/ skills override base/ skills
 * ```
 *
 * ## Example
 *
 * ```ts
 * const backend = new FilesystemBackend({ rootDir: "/app" });
 * const agent = new AgentForge({
 *   middleware: [
 *     new SkillsMiddleware({
 *       backend,
 *       sources: ["/skills/"],
 *     }),
 *   ],
 * });
 * ```
 */
export class SkillsMiddleware implements Middleware {
  readonly name = "skills";
  readonly tools: ToolDefinition[];

  private backend: BackendProtocol;
  private sources: string[];
  private skills: SkillMetadata[] = [];

  constructor(config: SkillsConfig) {
    this.backend = config.backend;
    this.sources = config.sources;

    // Create tool with closure to access loaded skills
    this.tools = [
      createLoadSkillTool(this.backend, () => this.skills),
    ];
  }

  async beforeExecute(
    state: PipelineState,
    _context: MiddlewareContext,
  ): Promise<StateUpdate | void> {
    // Load skills from all sources
    const allSkills = new Map<string, SkillMetadata>();

    for (const source of this.sources) {
      const sourceSkills = await this.loadSkillsFromSource(source);
      for (const skill of sourceSkills) {
        allSkills.set(skill.name, skill); // Later sources override
      }
    }

    this.skills = [...allSkills.values()];

    return {
      middlewareState: {
        [this.name]: {
          loadedSkills: this.skills.map((s) => s.name),
          skillCount: this.skills.length,
          sources: this.sources,
        },
      },
    };
  }

  modifySystemPrompt(prompt: string, _state: Readonly<PipelineState>): string {
    if (this.skills.length === 0) {
      return prompt;
    }

    const skillList = this.skills
      .map((skill) => {
        let line = `- **${skill.name}**: ${skill.description}`;
        if (skill.license) line += ` (License: ${skill.license})`;
        if (skill.allowedTools.length > 0) {
          line += `\n  -> Recommended tools: ${skill.allowedTools.join(", ")}`;
        }
        return line;
      })
      .join("\n");

    return prompt + SKILLS_SYSTEM_PROMPT_HEADER + skillList + SKILLS_SYSTEM_PROMPT_FOOTER;
  }

  /**
   * Load all skills from a single source directory.
   */
  private async loadSkillsFromSource(sourcePath: string): Promise<SkillMetadata[]> {
    const skills: SkillMetadata[] = [];

    try {
      // List directories in the source path
      const listResult = await this.backend.ls(sourcePath);
      if (!listResult.entries) return skills;

      // Each subdirectory may contain a SKILL.md
      const skillDirs = listResult.entries.filter((e) => e.isDir);

      for (const dir of skillDirs) {
        const skillMdPath = dir.path + "/SKILL.md";
        const readResult = await this.backend.read(skillMdPath);

        if (!readResult.content) continue;

        const directoryName = dir.path.split("/").pop() ?? "";
        const metadata = parseSkillMetadata(readResult.content, skillMdPath, directoryName);

        if (metadata) {
          skills.push(metadata);
        }
      }
    } catch {
      // Skip sources that can't be read
    }

    return skills;
  }
}

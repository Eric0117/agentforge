import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as readline from "node:readline/promises";
import { splitFrontmatter } from "./agents/io.js";
import { confirm } from "./confirm.js";
import { masterDir, requireWorkspace } from "./agentforge-config.js";
import { LANG_INSTRUCTIONS, type Lang } from "./skills-data.js";
import { runSyncSkills } from "./sync-skills.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export type AddSkillOptions = {
  pathArg?: string;
  fromFile?: string;
  noEdit: boolean;
  yes: boolean; // skip prompts where possible
};

export async function runAddSkill(opts: AddSkillOptions): Promise<void> {
  const root = resolve(opts.pathArg ?? process.cwd());
  const cfg = requireWorkspace(root);

  if (opts.fromFile) {
    await addFromFile(root, opts.fromFile);
  } else {
    await addInteractive(root, cfg.lang, opts.noEdit, opts.yes);
  }

  if (!opts.noEdit) {
    console.log("");
    console.log(`${BOLD}${CYAN}↻${RESET} propagating to agents...`);
    // adding a skill changes root-level skill indexes (e.g. AGENTS.md Skills
    // section), so we ask for a root-guide refresh as well.
    await runSyncSkills({
      pathArg: root,
      forceSkills: false,
      forceClaude: true,
    });
  } else {
    console.log("");
    console.log(
      `${DIM}master file ready. Edit it, then run \`agentforge sync-skills\` to propagate.${RESET}`,
    );
  }
}

async function addFromFile(root: string, fromFile: string): Promise<void> {
  const src = resolve(fromFile);
  if (!existsSync(src)) {
    process.stderr.write(
      `\n${RED}✗${RESET} Source file not found.\n  ${DIM}${src}${RESET}\n\n`,
    );
    process.exit(1);
  }
  if (!statSync(src).isFile()) {
    process.stderr.write(
      `\n${RED}✗${RESET} ${DIM}${src}${RESET} is not a regular file.\n  ${DIM}--from expects a .md file path${RESET}\n\n`,
    );
    process.exit(1);
  }
  const content = readFileSync(src, "utf8");
  const { frontmatter } = splitFrontmatter(content);
  const name = frontmatter["name"];
  if (!name || !frontmatter["description"]) {
    process.stderr.write(
      `\n${RED}✗${RESET} Missing required frontmatter in ${DIM}${src}${RESET}\n\n` +
        `  The file needs a frontmatter block at the top:\n` +
        `    ${DIM}---${RESET}\n` +
        `    ${CYAN}name:${RESET} my-skill\n` +
        `    ${CYAN}description:${RESET} One-line summary of what this skill does.\n` +
        `    ${DIM}---${RESET}\n\n`,
    );
    process.exit(1);
  }
  if (!isValidSkillName(name)) {
    process.stderr.write(
      `\n${RED}✗${RESET} Invalid skill name: "${name}"\n\n` +
        `  Use kebab-case: letters, digits, hyphens. Must start with a letter.\n` +
        `  ${DIM}Example: my-debug-helper${RESET}\n\n`,
    );
    process.exit(1);
  }
  const dst = join(masterDir(root), `${name}.md`);
  if (existsSync(dst)) {
    process.stderr.write(
      `\n${RED}✗${RESET} Skill "${name}" already exists.\n  ${DIM}${dst}${RESET}\n\n` +
        `  Run ${CYAN}agentforge remove-skill ${name}${RESET} to remove it, or choose a different name.\n\n`,
    );
    process.exit(1);
  }
  mkdirSync(masterDir(root), { recursive: true });
  copyFileSync(src, dst);
  console.log(`${GREEN}+${RESET} added master skill: ${name}  ${DIM}(from ${src})${RESET}`);
}

async function addInteractive(
  root: string,
  lang: Lang,
  noEdit: boolean,
  yes: boolean,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let name = "";
  while (true) {
    name = (await rl.question(
      `${CYAN}?${RESET} ${BOLD}Skill name${RESET} ${DIM}(kebab-case, e.g. my-debug-helper)${RESET} `,
    )).trim();
    if (!isValidSkillName(name)) {
      console.log(
        `  ${RED}invalid name.${RESET} ${DIM}letters/digits/hyphens, must start with a letter.${RESET}`,
      );
      continue;
    }
    if (existsSync(join(masterDir(root), `${name}.md`))) {
      console.log(`  ${RED}already exists:${RESET} ${name}`);
      continue;
    }
    break;
  }

  const description = (await rl.question(
    `${CYAN}?${RESET} ${BOLD}Description${RESET} ${DIM}(one line — what this skill does)${RESET}\n${DIM}›${RESET} `,
  )).trim();
  if (description === "") {
    rl.close();
    process.stderr.write(
      `\n${RED}✗${RESET} Description is required — it's how agents decide when to use this skill.\n\n`,
    );
    process.exit(1);
  }
  rl.close();

  // build placeholder body
  const body = buildPlaceholderBody(name, description, lang);
  const dst = join(masterDir(root), `${name}.md`);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, body);
  console.log(`${GREEN}+${RESET} wrote master file: agentforge/skills/${name}.md`);

  if (noEdit) return;

  const openEditor = yes || (await confirm("Open this skill in $EDITOR now?", true));
  if (!openEditor) return;

  await openInEditor(dst);
}

function isValidSkillName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

function buildPlaceholderBody(
  name: string,
  description: string,
  lang: Lang,
): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}

<!-- Write your skill instructions here. -->
<!-- When the user's request matches the description above, this content -->
<!-- becomes the agent's playbook for the response. -->

## When to apply

<!-- describe trigger conditions -->

## How to do it

<!-- step-by-step procedure -->

## Rules

<!-- constraints, safety, do/don't -->

## Output language

${LANG_INSTRUCTIONS[lang]}
`;
}

async function openInEditor(path: string): Promise<void> {
  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (await firstAvailable(["nano", "vim", "vi"]));
  if (!editor) {
    console.log(
      `${YELLOW}no $VISUAL/$EDITOR set and no fallback editor (nano/vim/vi) found.${RESET}`,
    );
    console.log(`  ${DIM}Edit the file manually: ${path}${RESET}`);
    return;
  }
  // split editor string in case it has args (e.g. "code -w")
  const parts = editor.split(/\s+/).filter(Boolean);
  const cmd = parts[0];
  const args = [...parts.slice(1), path];
  await new Promise<void>((resolveProm, rejectProm) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", rejectProm);
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolveProm();
      else rejectProm(new Error(`editor exited with code ${code}`));
    });
  });
}

async function firstAvailable(cmds: string[]): Promise<string | null> {
  for (const c of cmds) {
    const ok = await new Promise<boolean>((res) => {
      const child = spawn("which", [c], { stdio: "ignore" });
      child.on("exit", (code) => res(code === 0));
      child.on("error", () => res(false));
    });
    if (ok) return c;
  }
  return null;
}

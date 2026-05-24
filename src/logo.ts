const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

// cyan gradient for the letters — center-bright
const GRADIENT = [
  "\x1b[38;5;30m",
  "\x1b[38;5;37m",
  "\x1b[38;5;44m",
  "\x1b[38;5;50m",
  "\x1b[38;5;44m",
  "\x1b[38;5;37m",
];

// Everything below is in the same cyan / teal family as the letters.
const SPARK = "\x1b[38;5;87m";        // light cyan sparkles above
const ICE = "\x1b[38;5;87m";          // top of anvil — brightest
const BRIGHT_CYAN = "\x1b[38;5;51m";   // upper body
const MID_CYAN = "\x1b[38;5;44m";      // mid (matches letter mid-tone)
const TEAL = "\x1b[38;5;37m";          // lower body
const DEEP_TEAL = "\x1b[38;5;30m";     // base
const SHADOW = "\x1b[38;5;24m";        // deepest shadow at the bottom
const ACCENT = "\x1b[38;5;51m";        // hammer accents on the tagline
const SUB = "\x1b[38;5;245m";

const LOGO_LINES = [
  "   █████╗  ██████╗ ███████╗███╗   ██╗████████╗███████╗ ██████╗ ██████╗  ██████╗ ███████╗",
  "  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝",
  "  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   █████╗  ██║   ██║██████╔╝██║  ███╗█████╗",
  "  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝",
  "  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗",
  "  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

// floating sparkles around the anvil — per-row [gap, character] tuples.
// gap = columns away from the anvil silhouette (so they hug it regardless of
// which row of the anvil this is). -1 = no sparkle on that row.
type Spark = readonly [number, string];

// LEFT: gap = spaces *before* the anvil's first visible character.
//       smaller = closer to the anvil.
const LEFT_SPARKS: readonly Spark[] = [
  [2, "⋆"],
  [-1, ""],
  [3, "·"],
  [2, "✦"],
  [-1, ""],
  [4, "·"],
  [2, "⋆"],
  [-1, ""],
  [3, "✧"],
  [5, "·"],
  [-1, ""],
  [2, "⋆"],
  [4, "✦"],
];

// RIGHT: gap = spaces *after* the anvil row's last character.
const RIGHT_SPARKS: readonly Spark[] = [
  [3, "·"],
  [-1, ""],
  [5, "⋆"],
  [2, "✦"],
  [-1, ""],
  [4, "·"],
  [-1, ""],
  [3, "⋆"],
  [6, "·"],
  [-1, ""],
  [2, "✧"],
  [5, "·"],
  [-1, ""],
];

// anvil + hammer ASCII art — used verbatim as supplied
const ANVIL_ART = [
  "                =++++++:.::-:-===+=++*=+***##.",
  "         .:...:--=+#*=@*---========++++*###%#",
  "      =*#%#*=-..  .=@=@*:------=====++=",
  "         :=+++++===#@=@*:-----====+=",
  "              :+%@@@%+@+::-==--===:",
  "                   .+#@%*++++=+++",
  "                    =#%@@%==-====",
  "                    ++++++====++=",
  "                  :*#@@@@@---=-===-",
  "               -##*#%%%@@@+==*%%@@*+==",
  "            =##%%#%%%@%%%%=+++%@@@@@@++++",
  "            ####*#**++*+**+=--: :+###*==.",
  "                    .:===+*+=-",
];

const PAD = "                  ";

// cyan gradient matching the AGENTFORGE letters above:
// brightest at the top (light catches the hammer face) → deeper teal/blue
// at the bottom (heavy base in shadow).
function anvilColor(rowIndex: number, total: number): string {
  const r = rowIndex / total;
  if (r < 0.17) return ICE;
  if (r < 0.34) return BRIGHT_CYAN;
  if (r < 0.55) return MID_CYAN;
  if (r < 0.72) return TEAL;
  if (r < 0.90) return DEEP_TEAL;
  return SHADOW;
}

// build one anvil row with sparkles hugging the silhouette on either side.
// the anvil rows have variable leading whitespace; we treat ANVIL_INDENT plus
// each row's own leading spaces as the "left margin" the sparkle lives in.
function buildAnvilLine(i: number, total: number): string {
  const ANVIL_INDENT_COLS = 18; // shifts anvil under the AGENTFORGE letters
  const row = ANVIL_ART[i];
  const trimmed = row.trimStart();
  const rowLead = row.length - trimmed.length;
  const totalLead = ANVIL_INDENT_COLS + rowLead; // columns until the anvil draws

  const [lgap, lchar] = LEFT_SPARKS[i] ?? [-1, ""];
  const [rgap, rchar] = RIGHT_SPARKS[i] ?? [-1, ""];

  // left margin: spaces + optional sparkle `lgap` columns before the anvil
  let leftSegment: string;
  if (lgap >= 0 && lchar && lgap < totalLead) {
    const sparkleCol = totalLead - lgap;
    leftSegment =
      " ".repeat(sparkleCol) +
      `${SPARK}${lchar}${RESET}` +
      " ".repeat(Math.max(0, totalLead - sparkleCol - 1));
  } else {
    leftSegment = " ".repeat(totalLead);
  }

  // anvil — only the visible part (we already accounted for leading spaces)
  const anvilSegment = `${anvilColor(i, total)}${shaded(trimmed)}${RESET}`;

  // right margin: `rgap` spaces from anvil's last character, then sparkle
  const rightSegment =
    rgap >= 0 && rchar
      ? `${" ".repeat(rgap)}${SPARK}${rchar}${RESET}`
      : "";

  return leftSegment + anvilSegment + rightSegment;
}

// re-shade the source ASCII (which uses + # @ = * : - .) into block characters
// so the result reads as a metal silhouette instead of typed text.
//   @         → █  (full block)
//   # %       → ▓  (dark shade)
//   + * =     → ▒  (medium shade)
//   : - .     → ░  (light shade)
function shaded(line: string): string {
  let out = "";
  for (const ch of line) {
    switch (ch) {
      case "@":
        out += "█";
        break;
      case "#":
      case "%":
        out += "▓";
        break;
      case "+":
      case "*":
      case "=":
        out += "▒";
        break;
      case ":":
      case "-":
      case ".":
        out += "░";
        break;
      default:
        out += ch; // spaces and anything else pass through
    }
  }
  return out;
}

export function printLogo(): void {
  const lines: string[] = [""];

  // 1–6. letters with cyan gradient (no sparks above — sparkles live around
  // the anvil now).
  for (let i = 0; i < LOGO_LINES.length; i++) {
    lines.push(`${BOLD}${GRADIENT[i]}${LOGO_LINES[i]}${RESET}`);
  }

  // 7+. anvil ASCII, centered under the letters, with floating sparkles
  // flanking it on the left and right (per-row pattern in LEFT/RIGHT_SPARKS).
  for (let i = 0; i < ANVIL_ART.length; i++) {
    lines.push(buildAnvilLine(i, ANVIL_ART.length));
  }

  lines.push("");

  // tagline + subtitle, hammer-flanked
  lines.push(
    `${PAD}${ACCENT}${BOLD}⚒${RESET}  ${SUB}${ITALIC}forge your Claude Code workspace${RESET}  ${ACCENT}${BOLD}⚒${RESET}`,
  );
  lines.push(
    `${PAD}${DIM}bootstrap multi-repo · multi-worktree · multi-feature${RESET}`,
  );
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

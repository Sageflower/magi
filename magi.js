#!/usr/bin/env node
/*
 * MAGI SYSTEM — three-core AI deliberation
 *
 *   MELCHIOR-1 .. ChatGPT (codex CLI)
 *   BALTHASAR-2 . Claude  (claude CLI)
 *   CASPER-3 .... Gemini  (gemini CLI)
 *
 * Usage:  node magi.js "Should we deploy on Friday?"
 *         node magi.js            (prompts for a proposal)
 *
 * Set MAGI_ASCII=1 to disable kanji if your terminal font lacks CJK glyphs.
 */
"use strict";

const { spawn } = require("child_process");
const readline = require("readline");

const CONFIG = {
  timeoutMs: 240_000,
  cores: [
    {
      id: "MELCHIOR·1",
      engine: "CHATGPT",
      persona:
        "the scientist — cold logic, hard evidence, technical feasibility, and probability of success",
      cmd: "codex",
      args: ["exec", "--skip-git-repo-check", "-"],
    },
    {
      id: "BALTHASAR·2",
      engine: "CLAUDE",
      persona:
        "the mother — protection, safety, ethics, and the long-term wellbeing of everyone affected",
      cmd: "claude",
      args: ["-p"],
    },
    {
      id: "CASPER·3",
      engine: "GEMINI 3.6",
      persona:
        "the woman — intuition, desire, human nature, and pragmatic self-interest",
      cmd: "gemini",
      args: ["-m", "gemini-3.6-flash"],
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
      fallback: {
        engine: "QWEN",
        cmd: "qwen",
        args: [],
        env: { GEMINI_CLI_TRUST_WORKSPACE: "true", QWEN_CLI_TRUST_WORKSPACE: "true" },
      },
    },
  ],
};

// ---------------------------------------------------------------- ANSI helpers
const ESC = "\x1b[";
const C = {
  reset: ESC + "0m",
  bold: ESC + "1m",
  dim: ESC + "2m",
  orange: ESC + "38;5;208m",
  amber: ESC + "38;5;214m",
  green: ESC + "38;5;46m",
  red: ESC + "38;5;196m",
  gray: ESC + "38;5;244m",
  white: ESC + "38;5;255m",
  barBg: ESC + "48;5;208m" + ESC + "30m",
};
const KANJI = process.env.MAGI_ASCII
  ? { APPROVED: "", DENIED: "", OFFLINE: "", TIMEOUT: "", DELIB: "", STALE: "", DEAD: "" }
  : { APPROVED: "可決", DENIED: "否決", OFFLINE: "停止", TIMEOUT: "停止", DELIB: "審議中", STALE: "保留", DEAD: "全停止" };

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
function chW(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
    ? 2
    : 1;
}
const vis = (s) => [...stripAnsi(s)].reduce((n, ch) => n + chW(ch), 0);
const center = (s, w) => {
  const pad = Math.max(0, w - vis(s));
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + s + " ".repeat(pad - left);
};
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function wrap(text, width) {
  const out = [];
  for (const para of text.split(/\n+/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && vis(line) + 1 + vis(word) > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- deliberation
function buildPrompt(core, question) {
  return [
    `You are ${core.id}, one of the three MAGI supercomputers.`,
    `You embody ${core.persona}. Deliberate strictly from that perspective.`,
    ``,
    `A proposal has been submitted for deliberation:`,
    ``,
    `PROPOSAL: ${question}`,
    ``,
    `Rules:`,
    `- If the proposal is a question rather than a plan, treat "yes/affirmative" as APPROVED and "no/negative" as DENIED.`,
    `- Give your reasoning in at most 100 words of plain text. No markdown, no tools, no questions back.`,
    `- Abstention is not permitted. You must decide.`,
    `- Your FINAL line must be exactly "VERDICT: APPROVED" or "VERDICT: DENIED".`,
  ].join("\n");
}

function cleanOutput(core, raw) {
  const noise = [
    /^Loaded cached credentials/i,
    /^Data collection is disabled/i,
    /^OpenAI Codex/i,
    /^-{5,}$/,
    /^(workdir|model|provider|approval|sandbox|reasoning \w+|session id|tokens used):/i,
    /^\[\d{4}-\d{2}-\d{2}T/,
    /^(user|thinking|codex)$/i,
    /^Warning:/i,
    /^Ripgrep is not available/i,
  ];
  return stripAnsi(raw)
    .split(/\r?\n/)
    .filter((l) => !noise.some((rx) => rx.test(l.trim())))
    .join("\n")
    .trim();
}

function summarizeError(s) {
  const strip = (l) => l.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "").trim();
  const lines = s.split(/\r?\n/).map(strip).filter(Boolean);
  const interesting = lines.filter(
    (l) => /(error|unauthorized|not logged in|please|auth|quota|limit|exceeded)/i.test(l) && !/^- /.test(l)
  );
  const pick = interesting.length ? interesting : lines.slice(-3);
  const out = [...new Set(pick)].slice(0, 3);
  return out.join(" · ").slice(0, 300) || "no output from core";
}

function runCli(cmd, args, input, timeoutMs, extraEnv) {
  return new Promise((resolve) => {
    // args are fixed flags from CONFIG (never user input), safe to join for shell
    const child = spawn([cmd, ...args].join(" "), {
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...(extraEnv || {}) },
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function deliberate(core, question) {
  core.status = "DELIBERATING";
  core.start = Date.now();
  const prompt = buildPrompt(core, question);

  let res = await runCli(core.cmd, core.args, prompt, CONFIG.timeoutMs, core.env);
  if (res.code !== 0 && !res.timedOut && core.fallback) {
    core.engine = core.fallback.engine || core.engine;
    res = await runCli(core.fallback.cmd, core.fallback.args, prompt, CONFIG.timeoutMs, core.fallback.env);
  }
  core.ms = Date.now() - core.start;

  if (res.timedOut) {
    core.status = "TIMEOUT";
    core.detail = "core did not respond within the time limit";
    return;
  }
  const text = cleanOutput(core, res.stdout);
  const m = [...text.matchAll(/VERDICT:\s*(APPROVED|DENIED)/gi)].pop();
  if (m) {
    core.status = m[1].toUpperCase();
    core.reasoning = text.replace(/VERDICT:\s*(APPROVED|DENIED)\.?/gi, "").trim();
  } else {
    core.status = "OFFLINE";
    core.detail = summarizeError(stripAnsi(res.stderr) || text);
  }
}

// ---------------------------------------------------------------- rendering
const W = 74; // full display width
const BW = 24; // core box outer width
const CW = 20; // center node outer width
const LEFT_X = 2; // left box column
const RIGHT_X = W - 2 - BW; // right box column
const MID = 37; // center column of the display

const secsOf = (c) => (c.start ? ((c.ms ?? Date.now() - c.start) / 1000).toFixed(1) + "s" : "");

function statusLines(core, tick) {
  const secs = secsOf(core);
  switch (core.status) {
    case "DELIBERATING": {
      const barW = 14,
        span = barW - 3;
      let p = tick % (span * 2);
      if (p > span) p = span * 2 - p;
      const bar = C.amber + "░".repeat(p) + "▓▓▓" + "░".repeat(span - p) + C.reset;
      return [C.amber + SPIN[tick % SPIN.length] + " DELIBERATING" + C.reset, bar];
    }
    case "APPROVED":
      return [C.green + C.bold + "APPROVED" + C.reset, C.green + (KANJI.APPROVED ? KANJI.APPROVED + " · " : "") + secs + C.reset];
    case "DENIED":
      return [C.red + C.bold + "DENIED" + C.reset, C.red + (KANJI.DENIED ? KANJI.DENIED + " · " : "") + secs + C.reset];
    case "TIMEOUT":
    case "OFFLINE":
      return [C.gray + C.bold + core.status + C.reset, C.gray + (KANJI.OFFLINE ? KANJI.OFFLINE + " · " : "") + secs + C.reset];
    default:
      return [C.dim + "STANDBY" + C.reset, ""];
  }
}

function coreBox(core, tick, pos) {
  const o = C.orange, r = C.reset;
  const inner = BW - 2;
  const title =
    " " + C.bold + C.white + core.id + r +
    " ".repeat(Math.max(1, inner - 2 - core.id.length - core.engine.length)) +
    C.dim + core.engine + r + " ";
  const [s1, s2] = statusLines(core, tick);
  const half = (BW - 2 - 1) / 2; // dashes each side of a connector stub
  const top =
    pos === "bottom"
      ? o + "┌" + "─".repeat(Math.floor(half)) + "┴" + "─".repeat(Math.ceil(half)) + "┐" + r
      : o + "┌" + "─".repeat(inner) + "┐" + r;
  const bottom =
    pos === "bottom"
      ? o + "└" + "─".repeat(inner) + "┘" + r
      : o + "└" + "─".repeat(Math.floor(half)) + "┬" + "─".repeat(Math.ceil(half)) + "┘" + r;
  return [
    top,
    o + "│" + r + title + o + "│" + r,
    o + "├" + "─".repeat(inner) + "┤" + r,
    o + "│" + r + center(s1, inner) + o + "│" + r,
    o + "│" + r + center(s2, inner) + o + "│" + r,
    bottom,
  ];
}

function centerNode(cores, tick) {
  const o = C.orange, r = C.reset;
  const inner = CW - 2;
  const votes = cores.filter((c) => c.status === "APPROVED" || c.status === "DENIED");
  const pending = cores.some((c) => c.status === "DELIBERATING" || c.status === "STANDBY");
  let content;
  if (pending) {
    content =
      C.amber + SPIN[tick % SPIN.length] + " " + (KANJI.DELIB || "VOTING") + "  " +
      votes.length + "/3" + C.reset;
  } else {
    const res = resolution(cores);
    content = res.color + C.bold + (res.kanji ? res.kanji + " " : "") + res.short + C.reset;
  }
  const halfL = Math.floor((inner - 1) / 2);
  const halfR = inner - 1 - halfL;
  return [
    o + "╔" + "═".repeat(halfL) + "╧" + "═".repeat(halfR) + "╗" + r,
    o + "║" + r + center(C.bold + C.orange + "M A G I" + r, inner) + o + "║" + r,
    o + "║" + r + center(content, inner) + o + "║" + r,
    o + "╚" + "═".repeat(halfL) + "╤" + "═".repeat(halfR) + "╝" + r,
  ];
}

function resolution(cores) {
  const votes = cores.filter((c) => c.status === "APPROVED" || c.status === "DENIED");
  const yes = votes.filter((c) => c.status === "APPROVED").length;
  const no = votes.length - yes;
  if (votes.length === 0)
    return { verdict: "OFFLINE", short: "SILENT", kanji: KANJI.DEAD, text: "ALL CORES OFFLINE", color: C.gray };
  if (yes === no)
    return { verdict: "STALEMATE", short: `${yes}–${no}`, kanji: KANJI.STALE, text: `STALEMATE (${yes}–${no})`, color: C.amber };
  const verdict = yes > no ? "APPROVED" : "DENIED";
  const color = yes > no ? C.green : C.red;
  const kanji = yes > no ? KANJI.APPROVED : KANJI.DENIED;
  const kind =
    votes.length === 3 && (yes === 3 || no === 3)
      ? "UNANIMOUS"
      : `${Math.max(yes, no)}–${Math.min(yes, no)} MAJORITY`;
  return { verdict, short: `${verdict} ${Math.max(yes, no)}-${Math.min(yes, no)}`, kanji, text: `RESOLUTION : ${verdict}  (${kind})`, color };
}

function headerBar() {
  const left = "  NERV :: MAGI SYSTEM  ver.7.0";
  const right = "PRIORITY : AAA  ";
  return C.barBg + C.bold + left + " ".repeat(Math.max(1, W - left.length - right.length)) + right + C.reset;
}

function renderFrame(cores, question, tick, done) {
  const o = C.orange, d = C.dim, r = C.reset;
  const lines = [];
  lines.push(headerBar());
  lines.push("");
  lines.push(" " + o + "▌" + r + " " + C.bold + "PROPOSAL" + r);
  for (const l of wrap(question, W - 6)) lines.push(" " + o + "▌" + r + "   " + C.white + l + r);
  lines.push("");

  const lb = coreBox(cores[0], tick, "left");
  const rb = coreBox(cores[1], tick, "right");
  const gap = RIGHT_X - LEFT_X - BW;
  for (let i = 0; i < lb.length; i++) {
    lines.push(" ".repeat(LEFT_X) + lb[i] + " ".repeat(gap) + rb[i]);
  }
  const lStub = LEFT_X + Math.floor((BW - 2 - 1) / 2) + 1;
  const rStub = RIGHT_X + Math.floor((BW - 2 - 1) / 2) + 1;
  lines.push(o + " ".repeat(lStub) + "│" + " ".repeat(rStub - lStub - 1) + "│" + r);
  lines.push(
    o + " ".repeat(lStub) + "└" + "─".repeat(MID - lStub - 1) + "┬" + "─".repeat(rStub - MID - 1) + "┘" + r
  );
  const cx = Math.floor((W - CW) / 2);
  for (const l of centerNode(cores, tick)) lines.push(" ".repeat(cx) + l);
  lines.push(o + " ".repeat(MID) + "│" + r);
  const bx = Math.floor((W - BW) / 2);
  for (const l of coreBox(cores[2], tick, "bottom")) lines.push(" ".repeat(bx) + l);

  lines.push("");
  if (done) {
    lines.push(" " + d + "► DELIBERATION COMPLETE" + r);
  } else {
    const blink = tick % 10 < 5 ? C.amber : C.dim;
    lines.push(" " + blink + "► DELIBERATION IN PROGRESS" + r);
  }
  return lines;
}

// ---------------------------------------------------------------- main
function promptLine(text) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(text, (a) => {
      rl.close();
      res(a.trim());
    });
  });
}

async function runDeliberation(question) {
  const cores = CONFIG.cores.map((c) => ({ ...c, status: "STANDBY" }));
  const live = process.stdout.isTTY;
  let tick = 0;
  let prevLines = 0;

  const draw = (done) => {
    const frame = renderFrame(cores, question, tick++, done);
    if (prevLines) process.stdout.write(ESC + prevLines + "A");
    process.stdout.write(frame.map((l) => ESC + "2K" + l).join("\n") + "\n");
    prevLines = frame.length;
  };

  if (live) process.stdout.write(ESC + "?25l");

  const timer = live ? setInterval(draw, 120) : null;
  if (live) draw(false);

  await Promise.all(cores.map((c) => deliberate(c, question)));

  if (timer) clearInterval(timer);
  if (live) draw(true);
  else renderFrame(cores, question, 0, true).forEach((l) => console.log(l));

  const res = resolution(cores);
  console.log("");
  console.log(res.color + "═".repeat(W) + C.reset);
  console.log(res.color + C.bold + center((res.kanji ? res.kanji + "   " : "") + res.text, W) + C.reset);
  console.log(res.color + "═".repeat(W) + C.reset);

  for (const core of cores) {
    const col =
      core.status === "APPROVED" ? C.green : core.status === "DENIED" ? C.red : C.gray;
    const kanji =
      core.status === "APPROVED" ? KANJI.APPROVED : core.status === "DENIED" ? KANJI.DENIED : KANJI.OFFLINE;
    console.log(
      "\n " + col + "▌" + C.reset + " " + C.bold + C.white + core.id + C.reset +
      C.dim + " :: " + core.engine + C.reset + " — " + col + C.bold + core.status +
      (kanji ? " " + kanji : "") + C.reset + C.dim + (core.ms ? "  (" + secsOf(core) + ")" : "") + C.reset
    );
    const body = core.reasoning || core.detail || "";
    for (const l of wrap(body, W - 5)) console.log(" " + (core.status === "OFFLINE" || core.status === "TIMEOUT" ? C.gray : "") + "   " + l + C.reset);
  }
  console.log("");
  console.log(" " + C.dim + "MAGI DECISION LOGIC SYSTEM · TOKYO-3 · " + new Date().toISOString() + C.reset);
  console.log("");
  if (live) process.stdout.write(ESC + "?25h");
}

async function main() {
  process.on("exit", () => process.stdout.write(ESC + "?25h"));
  process.on("SIGINT", () => process.exit(130));

  const argQuestion = process.argv.slice(2).join(" ").trim();
  if (argQuestion) {
    await runDeliberation(argQuestion);
    return;
  }

  // Interactive mode (double-clicked exe or bare `magi`): loop until told to stop.
  console.log(headerBar());
  console.log("");
  console.log(" " + C.dim + "Submit a proposal for deliberation. Type 'exit' to shut down." + C.reset);
  console.log("");
  for (;;) {
    const q = await promptLine(" " + C.orange + "ENTER PROPOSAL ► " + C.reset);
    if (!q) continue;
    if (/^(exit|quit|q)$/i.test(q)) break;
    console.log("");
    await runDeliberation(q);
  }
  console.log(" " + C.dim + "MAGI system shutting down. Goodbye." + C.reset);
}

main();

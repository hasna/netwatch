#!/usr/bin/env bun

import {
  formatBytes,
  formatRate,
  formatDuration,
  parseLimit,
  padRight,
  padLeft,
  parseNetstatLine,
  parseNettopOutput,
  parseRouteOutput,
  saveSession,
  loadSession,
  type InterfaceStats,
  type SessionBaseline,
} from "./utils";

const REFRESH_MS = 1500;
const VERSION = "0.2.0";

// -- colors --
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const white = (s: string) => `\x1b[37m${s}\x1b[0m`;

function progressBar(used: number, limit: number, width: number = 30): string {
  const ratio = Math.min(used / limit, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = (ratio * 100).toFixed(1);

  let color = green;
  if (ratio > 0.9) color = red;
  else if (ratio > 0.7) color = yellow;

  const bar = color("█".repeat(filled)) + dim("░".repeat(empty));
  return `${bar} ${color(pct + "%")}`;
}

// -- data collection --
async function exec(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function getDefaultInterface(): Promise<string> {
  const out = await exec(["route", "get", "default"]);
  return parseRouteOutput(out);
}

async function getInterfaceStats(iface: string): Promise<InterfaceStats> {
  const out = await exec(["netstat", "-ib"]);
  const lines = out.split("\n");
  for (const line of lines) {
    const stats = parseNetstatLine(line, iface);
    if (stats) return stats;
  }
  return { name: iface, bytesIn: 0, bytesOut: 0 };
}

async function getTopProcesses(limit: number = 10) {
  const out = await exec(["nettop", "-P", "-x", "-d", "-L", "2", "-n", "-J", "bytes_in,bytes_out"]);
  return parseNettopOutput(out, limit);
}

// -- CLI args --
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
${bold("open-netwatch")} v${VERSION} - Live network traffic monitor

${bold("USAGE")}
  ${cyan("netwatch")}                    Start monitoring (resumes tracked session)
  ${cyan("netwatch --reset")}            Start a new tracking session (run when you connect hotspot)
  ${cyan("netwatch --limit 5")}          Set data cap to 5 GB
  ${cyan("netwatch --limit 500mb")}      Set data cap to 500 MB
  ${cyan("netwatch --interface en0")}    Monitor specific interface
  ${cyan("netwatch --top 15")}           Show top 15 processes

${bold("OPTIONS")}
  ${green("--reset")}                Reset tracking session (use when connecting to hotspot)
  ${green("-l, --limit <size>")}     Data cap (e.g. 5, 5gb, 500mb). Default: none
  ${green("-i, --interface <if>")}   Network interface. Default: auto-detect
  ${green("-t, --top <n>")}          Number of top processes. Default: 10
  ${green("-r, --refresh <ms>")}     Refresh interval in ms. Default: 1500
  ${green("-h, --help")}             Show this help
  ${green("-v, --version")}          Show version

${bold("HOW IT WORKS")}
  Netwatch tracks cumulative data usage across restarts by saving a baseline
  to ${dim("~/.netwatch/session.json")}. The first run auto-creates a session.
  Use ${cyan("--reset")} when you connect to a new hotspot to start fresh.
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`open-netwatch v${VERSION}`);
  process.exit(0);
}

function getArg(flags: string[]): string | undefined {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  }
  return undefined;
}

const doReset = args.includes("--reset");
const limitStr = getArg(["-l", "--limit"]);
const dataLimit = limitStr ? parseLimit(limitStr) : null;
const topN = parseInt(getArg(["-t", "--top"]) || "10", 10);
const refreshMs = parseInt(getArg(["-r", "--refresh"]) || String(REFRESH_MS), 10);
let iface = getArg(["-i", "--interface"]);

// -- main loop --
async function main() {
  if (!iface) {
    iface = await getDefaultInterface();
  }

  // get current interface counters
  const currentStats = await getInterfaceStats(iface);

  // load or create persistent session baseline
  let baseline: SessionBaseline;
  const existing = loadSession();

  if (doReset || !existing || existing.iface !== iface) {
    baseline = {
      iface,
      bytesIn: currentStats.bytesIn,
      bytesOut: currentStats.bytesOut,
      startedAt: Date.now(),
    };
    saveSession(baseline);
    if (doReset) {
      console.log(green(`  Session reset! Tracking from now on ${iface}.`));
    } else if (!existing) {
      console.log(green(`  New session started on ${iface}. Use --reset to restart tracking.`));
    } else {
      console.log(yellow(`  Interface changed to ${iface}. Session reset automatically.`));
    }
  } else {
    baseline = existing;
  }

  // for live rate calculation
  const cliStartTime = Date.now();
  let prevStats = currentStats;
  let prevTime = cliStartTime;

  console.clear();

  const tick = async () => {
    const now = Date.now();
    const elapsed = (now - prevTime) / 1000;

    const stats = await getInterfaceStats(iface!);
    const processes = await getTopProcesses(topN);

    // live rates (delta since last tick)
    const deltaIn = stats.bytesIn - prevStats.bytesIn;
    const deltaOut = stats.bytesOut - prevStats.bytesOut;
    const rateIn = elapsed > 0 ? deltaIn / elapsed : 0;
    const rateOut = elapsed > 0 ? deltaOut / elapsed : 0;

    // tracked totals (since baseline / hotspot connect)
    const trackedIn = Math.max(0, stats.bytesIn - baseline.bytesIn);
    const trackedOut = Math.max(0, stats.bytesOut - baseline.bytesOut);
    const trackedTotal = trackedIn + trackedOut;
    const trackingDuration = now - baseline.startedAt;

    prevStats = stats;
    prevTime = now;

    // build output
    const lines: string[] = [];
    const width = process.stdout.columns || 80;
    const sep = dim("─".repeat(width));

    lines.push("\x1b[H\x1b[J");
    lines.push(bold(`  open-netwatch`) + dim(` v${VERSION}`) + dim(`  │  ${iface}  │  ${new Date().toLocaleTimeString()}`));
    lines.push(sep);

    // live rates
    lines.push(
      `  ${dim("Tracking:")} ${white(formatDuration(trackingDuration))}` +
      `    ${dim("Down:")} ${cyan(formatRate(rateIn))}` +
      `    ${dim("Up:")} ${magenta(formatRate(rateOut))}`
    );
    lines.push("");

    // tracked totals (the important numbers)
    lines.push(`  ${dim("Downloaded:")}  ${padLeft(cyan(formatBytes(trackedIn)), 14)}`);
    lines.push(`  ${dim("Uploaded:  ")}  ${padLeft(magenta(formatBytes(trackedOut)), 14)}`);
    lines.push(`  ${bold("Total:     ")}  ${padLeft(bold(formatBytes(trackedTotal)), 14)}`);

    // data limit bar
    if (dataLimit) {
      lines.push("");
      const remaining = Math.max(0, dataLimit - trackedTotal);
      lines.push(`  ${dim("Limit:")}  ${formatBytes(dataLimit)}    ${dim("Remaining:")}  ${formatBytes(remaining)}`);
      lines.push(`  ${progressBar(trackedTotal, dataLimit, Math.min(50, width - 12))}`);

      if (trackedTotal > dataLimit * 0.9) {
        lines.push(`  ${red(bold("  WARNING: Over 90% of data limit used!"))}`);
      }
    }

    lines.push(sep);
    lines.push(bold("  Top Processes") + dim(` (by traffic this session)`));
    lines.push("");

    const nameWidth = Math.max(20, Math.min(30, width - 50));
    lines.push(
      `  ${dim(padRight("PROCESS", nameWidth))}` +
      `${dim(padLeft("DOWN", 12))}` +
      `${dim(padLeft("UP", 12))}` +
      `${dim(padLeft("TOTAL", 12))}`
    );

    for (const p of processes) {
      const total = p.bytesIn + p.bytesOut;
      const name = p.name.length > nameWidth - 2 ? p.name.slice(0, nameWidth - 5) + "..." : p.name;
      lines.push(
        `  ${padRight(white(name), nameWidth)}` +
        `${padLeft(cyan(formatBytes(p.bytesIn)), 12)}` +
        `${padLeft(magenta(formatBytes(p.bytesOut)), 12)}` +
        `${padLeft(formatBytes(total), 12)}`
      );
    }

    if (processes.length === 0) {
      lines.push(dim("  No active network processes"));
    }

    lines.push("");
    lines.push(dim(`  Since ${new Date(baseline.startedAt).toLocaleString()}  │  --reset to restart tracking  │  Ctrl+C to quit`));

    process.stdout.write(lines.join("\n"));
  };

  await tick();

  const interval = setInterval(tick, refreshMs);

  process.on("SIGINT", () => {
    clearInterval(interval);
    const stats = prevStats;
    const trackedIn = Math.max(0, stats.bytesIn - baseline.bytesIn);
    const trackedOut = Math.max(0, stats.bytesOut - baseline.bytesOut);
    const duration = Date.now() - baseline.startedAt;

    console.log("\n");
    console.log(bold("  Session Summary") + dim(` (${formatDuration(duration)} tracked)`));
    console.log(dim("  ─".repeat(20)));
    console.log(`  Downloaded:  ${cyan(formatBytes(trackedIn))}`);
    console.log(`  Uploaded:    ${magenta(formatBytes(trackedOut))}`);
    console.log(`  Total:       ${bold(formatBytes(trackedIn + trackedOut))}`);
    console.log(dim(`\n  Session saved. Run netwatch again to resume tracking.`));
    console.log("");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(red(`Error: ${err.message}`));
  process.exit(1);
});

#!/usr/bin/env bun

const REFRESH_MS = 1500;
const VERSION = "0.1.0";

// -- colors --
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const white = (s: string) => `\x1b[37m${s}\x1b[0m`;

// -- helpers --
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

function padRight(s: string, n: number): string {
  // strip ANSI for length calculation
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, n - plain.length));
}

function padLeft(s: string, n: number): string {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return " ".repeat(Math.max(0, n - plain.length)) + s;
}

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
interface InterfaceStats {
  name: string;
  bytesIn: number;
  bytesOut: number;
}

interface ProcessStats {
  name: string;
  bytesIn: number;
  bytesOut: number;
}

async function exec(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function getDefaultInterface(): Promise<string> {
  const out = await exec(["route", "get", "default"]);
  const match = out.match(/interface:\s*(\S+)/);
  return match?.[1] ?? "en0";
}

async function getInterfaceStats(iface: string): Promise<InterfaceStats> {
  const out = await exec(["netstat", "-ib"]);
  const lines = out.split("\n");
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    // format: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    if (parts[0] === iface && parts[2] === "<Link#" + parts[2].match(/\d+/)?.[0] + ">") {
      // Link line has the raw bytes
      return {
        name: iface,
        bytesIn: parseInt(parts[6], 10) || 0,
        bytesOut: parseInt(parts[9], 10) || 0,
      };
    }
  }
  // fallback: find first line matching interface with <Link#
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === iface && parts[2]?.startsWith("<Link#")) {
      return {
        name: iface,
        bytesIn: parseInt(parts[6], 10) || 0,
        bytesOut: parseInt(parts[9], 10) || 0,
      };
    }
  }
  return { name: iface, bytesIn: 0, bytesOut: 0 };
}

async function getTopProcesses(limit: number = 10): Promise<ProcessStats[]> {
  const out = await exec(["nettop", "-P", "-x", "-d", "-L", "2", "-n", "-J", "bytes_in,bytes_out"]);
  const lines = out.trim().split("\n");
  const processes: ProcessStats[] = [];

  for (const line of lines) {
    // format: name.pid,bytes_in,bytes_out,
    if (line.startsWith(",") || !line.includes(",")) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;

    const rawName = parts[0].trim();
    const bytesIn = parseInt(parts[1], 10) || 0;
    const bytesOut = parseInt(parts[2], 10) || 0;

    if (bytesIn === 0 && bytesOut === 0) continue;

    // clean up process name (remove PID suffix)
    const name = rawName.replace(/\.\d+$/, "");

    processes.push({ name, bytesIn, bytesOut });
  }

  // merge processes with same name
  const merged = new Map<string, ProcessStats>();
  for (const p of processes) {
    const existing = merged.get(p.name);
    if (existing) {
      existing.bytesIn += p.bytesIn;
      existing.bytesOut += p.bytesOut;
    } else {
      merged.set(p.name, { ...p });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut))
    .slice(0, limit);
}

// -- CLI args --
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
${bold("open-netwatch")} v${VERSION} - Live network traffic monitor

${bold("USAGE")}
  ${cyan("netwatch")}                    Start monitoring
  ${cyan("netwatch --limit 5")}          Set data cap to 5 GB
  ${cyan("netwatch --limit 500mb")}      Set data cap to 500 MB
  ${cyan("netwatch --interface en0")}    Monitor specific interface
  ${cyan("netwatch --top 15")}           Show top 15 processes

${bold("OPTIONS")}
  ${green("-l, --limit <size>")}     Data cap (e.g. 5, 5gb, 500mb). Default: none
  ${green("-i, --interface <if>")}   Network interface. Default: auto-detect
  ${green("-t, --top <n>")}          Number of top processes. Default: 10
  ${green("-r, --refresh <ms>")}     Refresh interval in ms. Default: 1500
  ${green("-h, --help")}             Show this help
  ${green("-v, --version")}          Show version
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

function parseLimit(val: string): number | null {
  const match = val.match(/^([\d.]+)\s*(gb|mb|tb)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || "gb").toLowerCase();
  if (unit === "tb") return num * 1024 * 1024 * 1024 * 1024;
  if (unit === "gb") return num * 1024 * 1024 * 1024;
  if (unit === "mb") return num * 1024 * 1024;
  return num * 1024 * 1024 * 1024; // default GB
}

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

  const startStats = await getInterfaceStats(iface);
  const startTime = Date.now();
  let sessionIn = 0;
  let sessionOut = 0;
  let prevStats = startStats;
  let prevTime = startTime;

  console.clear();
  console.log(dim(`open-netwatch v${VERSION} - monitoring ${iface}... (Ctrl+C to quit)\n`));

  const tick = async () => {
    const now = Date.now();
    const elapsed = (now - prevTime) / 1000;
    const totalElapsed = (now - startTime) / 1000;

    const stats = await getInterfaceStats(iface!);
    const processes = await getTopProcesses(topN);

    // delta since last tick
    const deltaIn = stats.bytesIn - prevStats.bytesIn;
    const deltaOut = stats.bytesOut - prevStats.bytesOut;

    // rates
    const rateIn = elapsed > 0 ? deltaIn / elapsed : 0;
    const rateOut = elapsed > 0 ? deltaOut / elapsed : 0;

    // session totals
    sessionIn = stats.bytesIn - startStats.bytesIn;
    sessionOut = stats.bytesOut - startStats.bytesOut;
    const sessionTotal = sessionIn + sessionOut;

    prevStats = stats;
    prevTime = now;

    // build output
    const lines: string[] = [];
    const width = process.stdout.columns || 80;
    const sep = dim("─".repeat(width));

    lines.push("\x1b[H\x1b[J"); // clear screen, cursor to top
    lines.push(bold(`  open-netwatch`) + dim(` v${VERSION}`) + dim(`  │  ${iface}  │  ${new Date().toLocaleTimeString()}`));
    lines.push(sep);

    // session stats
    const uptime = `${Math.floor(totalElapsed / 60)}m ${Math.floor(totalElapsed % 60)}s`;
    lines.push(
      `  ${dim("Session:")} ${white(uptime)}` +
      `    ${dim("Down:")} ${cyan(formatRate(rateIn))}` +
      `    ${dim("Up:")} ${magenta(formatRate(rateOut))}`
    );
    lines.push("");

    // totals
    lines.push(`  ${dim("Downloaded:")}  ${padLeft(cyan(formatBytes(sessionIn)), 14)}`);
    lines.push(`  ${dim("Uploaded:  ")}  ${padLeft(magenta(formatBytes(sessionOut)), 14)}`);
    lines.push(`  ${dim("Total:     ")}  ${padLeft(bold(formatBytes(sessionTotal)), 14)}`);

    // data limit bar
    if (dataLimit) {
      lines.push("");
      const remaining = Math.max(0, dataLimit - sessionTotal);
      lines.push(`  ${dim("Limit:")}  ${formatBytes(dataLimit)}    ${dim("Remaining:")}  ${formatBytes(remaining)}`);
      lines.push(`  ${progressBar(sessionTotal, dataLimit, Math.min(50, width - 12))}`);

      if (sessionTotal > dataLimit * 0.9) {
        lines.push(`  ${red(bold("  WARNING: Over 90% of data limit used!"))}`);
      }
    }

    lines.push(sep);

    // top processes
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
    lines.push(dim("  Press Ctrl+C to quit"));

    process.stdout.write(lines.join("\n"));
  };

  // initial tick
  await tick();

  // loop
  const interval = setInterval(tick, refreshMs);

  // graceful exit
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("\n");
    console.log(bold("  Session Summary"));
    console.log(dim("  ─".repeat(20)));
    console.log(`  Downloaded:  ${cyan(formatBytes(sessionIn))}`);
    console.log(`  Uploaded:    ${magenta(formatBytes(sessionOut))}`);
    console.log(`  Total:       ${bold(formatBytes(sessionIn + sessionOut))}`);
    console.log("");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(red(`Error: ${err.message}`));
  process.exit(1);
});

export interface ProcessStats {
  name: string;
  bytesIn: number;
  bytesOut: number;
}

export interface InterfaceStats {
  name: string;
  bytesIn: number;
  bytesOut: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

export function parseLimit(val: string): number | null {
  const match = val.match(/^([\d.]+)\s*(gb|mb|tb)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || "gb").toLowerCase();
  if (unit === "tb") return num * 1024 * 1024 * 1024 * 1024;
  if (unit === "gb") return num * 1024 * 1024 * 1024;
  if (unit === "mb") return num * 1024 * 1024;
  return num * 1024 * 1024 * 1024;
}

export function padRight(s: string, n: number): string {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, n - plain.length));
}

export function padLeft(s: string, n: number): string {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  return " ".repeat(Math.max(0, n - plain.length)) + s;
}

export function parseNetstatLine(line: string, iface: string): InterfaceStats | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === iface && parts[2]?.startsWith("<Link#")) {
    return {
      name: iface,
      bytesIn: parseInt(parts[6], 10) || 0,
      bytesOut: parseInt(parts[9], 10) || 0,
    };
  }
  return null;
}

export function parseNettopOutput(output: string, limit: number): ProcessStats[] {
  const lines = output.trim().split("\n");
  const processes: ProcessStats[] = [];

  for (const line of lines) {
    if (line.startsWith(",") || !line.includes(",")) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;

    const rawName = parts[0].trim();
    const bytesIn = parseInt(parts[1], 10) || 0;
    const bytesOut = parseInt(parts[2], 10) || 0;

    if (bytesIn === 0 && bytesOut === 0) continue;

    const name = rawName.replace(/\.\d+$/, "");
    processes.push({ name, bytesIn, bytesOut });
  }

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

export function parseRouteOutput(output: string): string {
  const match = output.match(/interface:\s*(\S+)/);
  return match?.[1] ?? "en0";
}

// -- persistent session tracking --
export interface SessionBaseline {
  iface: string;
  bytesIn: number;
  bytesOut: number;
  startedAt: number; // unix ms
}

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const SESSION_DIR = join(homedir(), ".netwatch");
const SESSION_FILE = join(SESSION_DIR, "session.json");

export function saveSession(baseline: SessionBaseline): void {
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }
  writeFileSync(SESSION_FILE, JSON.stringify(baseline, null, 2));
}

export function loadSession(): SessionBaseline | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    if (data && typeof data.bytesIn === "number" && typeof data.bytesOut === "number" && typeof data.startedAt === "number") {
      return data as SessionBaseline;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

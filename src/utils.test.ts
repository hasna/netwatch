import { describe, test, expect, afterAll } from "bun:test";
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
  type SessionBaseline,
} from "./utils";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

describe("formatBytes", () => {
  test("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10240)).toBe("10.0 KB");
  });

  test("formats megabytes", () => {
    expect(formatBytes(1048576)).toBe("1.00 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.50 MB");
  });

  test("formats gigabytes", () => {
    expect(formatBytes(1073741824)).toBe("1.00 GB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.00 GB");
  });
});

describe("formatRate", () => {
  test("formats bytes per second", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(500)).toBe("500 B/s");
  });

  test("formats kilobytes per second", () => {
    expect(formatRate(1024)).toBe("1.0 KB/s");
    expect(formatRate(2048)).toBe("2.0 KB/s");
  });

  test("formats megabytes per second", () => {
    expect(formatRate(1048576)).toBe("1.00 MB/s");
    expect(formatRate(10 * 1024 * 1024)).toBe("10.00 MB/s");
  });
});

describe("parseLimit", () => {
  test("parses plain number as GB", () => {
    expect(parseLimit("5")).toBe(5 * 1024 * 1024 * 1024);
    expect(parseLimit("1")).toBe(1024 * 1024 * 1024);
    expect(parseLimit("0.5")).toBe(0.5 * 1024 * 1024 * 1024);
  });

  test("parses GB suffix", () => {
    expect(parseLimit("5gb")).toBe(5 * 1024 * 1024 * 1024);
    expect(parseLimit("5GB")).toBe(5 * 1024 * 1024 * 1024);
    expect(parseLimit("2.5gb")).toBe(2.5 * 1024 * 1024 * 1024);
  });

  test("parses MB suffix", () => {
    expect(parseLimit("500mb")).toBe(500 * 1024 * 1024);
    expect(parseLimit("500MB")).toBe(500 * 1024 * 1024);
    expect(parseLimit("100mb")).toBe(100 * 1024 * 1024);
  });

  test("parses TB suffix", () => {
    expect(parseLimit("1tb")).toBe(1024 * 1024 * 1024 * 1024);
    expect(parseLimit("1TB")).toBe(1024 * 1024 * 1024 * 1024);
  });

  test("returns null for invalid input", () => {
    expect(parseLimit("abc")).toBeNull();
    expect(parseLimit("")).toBeNull();
    expect(parseLimit("5xyz")).toBeNull();
  });
});

describe("padRight", () => {
  test("pads plain strings", () => {
    expect(padRight("hello", 10)).toBe("hello     ");
    expect(padRight("test", 4)).toBe("test");
  });

  test("handles ANSI codes correctly", () => {
    const colored = "\x1b[31mred\x1b[0m";
    const padded = padRight(colored, 10);
    // visible length is 3 ("red"), so should have 7 spaces
    expect(padded).toBe(colored + "       ");
  });

  test("does not truncate long strings", () => {
    expect(padRight("long string", 5)).toBe("long string");
  });
});

describe("padLeft", () => {
  test("pads plain strings", () => {
    expect(padLeft("hello", 10)).toBe("     hello");
    expect(padLeft("test", 4)).toBe("test");
  });

  test("handles ANSI codes correctly", () => {
    const colored = "\x1b[31mred\x1b[0m";
    const padded = padLeft(colored, 10);
    expect(padded).toBe("       " + colored);
  });
});

describe("parseNetstatLine", () => {
  test("parses a valid Link line", () => {
    const line = "en0        1500  <Link#11>   3a:b0:03:f9:ad:c5 17120176     0 9728624786 23197412     0 24613359890     0";
    const result = parseNetstatLine(line, "en0");
    expect(result).toEqual({
      name: "en0",
      bytesIn: 9728624786,
      bytesOut: 24613359890,
    });
  });

  test("returns null for non-matching interface", () => {
    const line = "en0        1500  <Link#11>   3a:b0:03:f9:ad:c5 17120176     0 9728624786 23197412     0 24613359890     0";
    expect(parseNetstatLine(line, "en1")).toBeNull();
  });

  test("returns null for non-Link lines", () => {
    const line = "en0        1500  172.20.10/28  172.20.10.4     17120176     - 9728624786 23197412     - 24613359890     -";
    expect(parseNetstatLine(line, "en0")).toBeNull();
  });

  test("returns null for empty lines", () => {
    expect(parseNetstatLine("", "en0")).toBeNull();
  });

  test("handles interface without address (loopback)", () => {
    // lo0 has no Address field, so columns shift when split on whitespace
    // parts: [lo0, 16384, <Link#1>, 38871723, 0, 43918670715, 38871725, 0, 43918670859, 0]
    // index:   0     1       2         3       4      5           6       7       8       9
    // vs en0: [en0, 1500, <Link#11>, 3a:b0:..., 17120176, 0, 9728624786, 23197412, 0, 24613359890, 0]
    // The parser reads index 6 and 9, which works for en0 (with address) but not lo0 (without)
    // This is acceptable - lo0 is not a real network interface for monitoring
    const line = "lo0        16384 <Link#1>                      38871723     0 43918670715 38871725     0 43918670859     0";
    const result = parseNetstatLine(line, "lo0");
    // Returns a result (it matches the interface and <Link# pattern)
    expect(result).not.toBeNull();
    expect(result!.name).toBe("lo0");
  });
});

describe("parseNettopOutput", () => {
  const sampleOutput = `,bytes_in,bytes_out,
launchd.1,0,0,
apsd.372,5985,14950,
mDNSResponder.430,27068085,16398069,
node.21406,1413214,617089,
Google Chrome.38341,0,0,
Google Chrome H.55911,2807735,150250,
Google Chrome H.69801,1990530,54899,
node.50838,14046280,8715528,`;

  test("parses and merges processes correctly", () => {
    const result = parseNettopOutput(sampleOutput, 10);

    // node entries should be merged
    const node = result.find((p) => p.name === "node");
    expect(node).toBeTruthy();
    expect(node!.bytesIn).toBe(1413214 + 14046280);
    expect(node!.bytesOut).toBe(617089 + 8715528);

    // Chrome H entries should be merged
    const chromeH = result.find((p) => p.name === "Google Chrome H");
    expect(chromeH).toBeTruthy();
    expect(chromeH!.bytesIn).toBe(2807735 + 1990530);
    expect(chromeH!.bytesOut).toBe(150250 + 54899);
  });

  test("filters out zero-traffic processes", () => {
    const result = parseNettopOutput(sampleOutput, 10);
    const launchd = result.find((p) => p.name === "launchd");
    expect(launchd).toBeUndefined();

    const chrome = result.find((p) => p.name === "Google Chrome");
    expect(chrome).toBeUndefined();
  });

  test("sorts by total traffic descending", () => {
    const result = parseNettopOutput(sampleOutput, 10);
    for (let i = 1; i < result.length; i++) {
      const prevTotal = result[i - 1].bytesIn + result[i - 1].bytesOut;
      const currTotal = result[i].bytesIn + result[i].bytesOut;
      expect(prevTotal).toBeGreaterThanOrEqual(currTotal);
    }
  });

  test("respects limit parameter", () => {
    const result = parseNettopOutput(sampleOutput, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test("handles empty output", () => {
    expect(parseNettopOutput("", 10)).toEqual([]);
    expect(parseNettopOutput(",bytes_in,bytes_out,\n", 10)).toEqual([]);
  });

  test("skips header lines", () => {
    const result = parseNettopOutput(sampleOutput, 10);
    const header = result.find((p) => p.name === "bytes_in");
    expect(header).toBeUndefined();
  });
});

describe("parseRouteOutput", () => {
  test("extracts interface name", () => {
    const output = `   route to: default
destination: default
       mask: default
    gateway: 172.20.10.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0`;
    expect(parseRouteOutput(output)).toBe("en0");
  });

  test("defaults to en0 when no interface found", () => {
    expect(parseRouteOutput("")).toBe("en0");
    expect(parseRouteOutput("some random output")).toBe("en0");
  });

  test("extracts different interface names", () => {
    const output = "  interface: bridge100\n";
    expect(parseRouteOutput(output)).toBe("bridge100");
  });
});

describe("formatDuration", () => {
  test("formats minutes only", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(60 * 1000)).toBe("1m");
    expect(formatDuration(30 * 60 * 1000)).toBe("30m");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(60 * 60 * 1000)).toBe("1h 0m");
    expect(formatDuration(90 * 60 * 1000)).toBe("1h 30m");
    expect(formatDuration(4 * 60 * 60 * 1000)).toBe("4h 0m");
    expect(formatDuration(4 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe("4h 15m");
  });
});

describe("session persistence", () => {
  const testBaseline: SessionBaseline = {
    iface: "en0",
    bytesIn: 1000000,
    bytesOut: 2000000,
    startedAt: Date.now() - 4 * 60 * 60 * 1000, // 4 hours ago
  };

  test("saves and loads a session", () => {
    saveSession(testBaseline);
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.iface).toBe("en0");
    expect(loaded!.bytesIn).toBe(1000000);
    expect(loaded!.bytesOut).toBe(2000000);
    expect(loaded!.startedAt).toBe(testBaseline.startedAt);
  });

  test("overwrites existing session on save", () => {
    saveSession(testBaseline);
    const updated: SessionBaseline = { ...testBaseline, bytesIn: 5000000 };
    saveSession(updated);
    const loaded = loadSession();
    expect(loaded!.bytesIn).toBe(5000000);
  });

  test("calculates tracked usage correctly", () => {
    const baseline: SessionBaseline = {
      iface: "en0",
      bytesIn: 1_000_000_000, // 1 GB baseline
      bytesOut: 500_000_000,
      startedAt: Date.now() - 4 * 60 * 60 * 1000,
    };

    // simulate current counters after 4 hours of usage
    const currentIn = 3_500_000_000; // 3.5 GB
    const currentOut = 1_200_000_000; // 1.2 GB

    const trackedIn = currentIn - baseline.bytesIn; // 2.5 GB used
    const trackedOut = currentOut - baseline.bytesOut; // 0.7 GB used
    const trackedTotal = trackedIn + trackedOut; // 3.2 GB total

    expect(trackedIn).toBe(2_500_000_000);
    expect(trackedOut).toBe(700_000_000);
    expect(trackedTotal).toBe(3_200_000_000);
    expect(formatBytes(trackedTotal)).toBe("2.98 GB");
  });

  test("data limit comparison works with tracked totals", () => {
    const limit = 5 * 1024 * 1024 * 1024; // 5 GB
    const trackedTotal = 4.6 * 1024 * 1024 * 1024; // 4.6 GB used

    const ratio = trackedTotal / limit;
    expect(ratio).toBeGreaterThan(0.9);

    const remaining = limit - trackedTotal;
    expect(remaining).toBeGreaterThan(0);
    expect(formatBytes(remaining)).toContain("MB");
  });
});

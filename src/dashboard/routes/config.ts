import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, saveConfig } from "../../cli/config.js";
import { getDb } from "../../db/index.js";

export const configRoutes = new Hono();

// Block link-local, loopback, private ranges, and known cloud-metadata hostnames for SSRF defense.
function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  const metadataHosts = new Set([
    "metadata.google.internal",
    "metadata.goog",
    "metadata",
  ]);
  if (metadataHosts.has(host)) return true;

  // IPv4 dotted-quad
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 127) return true;                       // 127.0.0.0/8 loopback
    if (a === 10) return true;                        // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local incl. 169.254.169.254
    if (a === 0) return true;                         // 0.0.0.0/8
    if (a === 192 && b === 0 && parseInt(v4[3], 10) === 192) return true; // Oracle metadata 192.0.0.192
    return false;
  }

  // IPv6 — block loopback, link-local, unique-local, IPv4-mapped private/link-local
  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host.startsWith("fe80:") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true; // fe80::/10
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7
    const mapped = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedHost(mapped[1]);
    const mappedHex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const a = parseInt(mappedHex[1], 16);
      const b = parseInt(mappedHex[2], 16);
      const ip = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
      return isBlockedHost(ip);
    }
    return false;
  }

  // Bare names / non-IP — block well-known metadata aliases above; everything else allowed
  return false;
}

// GET /api/config
configRoutes.get("/config", (c) => {
  const config = loadConfig();
  return c.json(config);
});

// PUT /api/config
configRoutes.put("/config", async (c) => {
  const body = await c.req.json();
  const current = loadConfig();

  // Validate analysis.baseUrl if provided: must be http(s) and not target link-local/metadata/private addresses.
  if (body?.analysis?.baseUrl !== undefined && body.analysis.baseUrl !== null && body.analysis.baseUrl !== "") {
    try {
      const u = new URL(body.analysis.baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return c.json({ error: "analysis.baseUrl must use http or https" }, 400);
      }
      if (isBlockedHost(u.hostname)) {
        return c.json({ error: "analysis.baseUrl host is not allowed" }, 400);
      }
    } catch {
      return c.json({ error: "analysis.baseUrl is not a valid URL" }, 400);
    }
  }

  // Allowlist top-level keys to avoid writing arbitrary attacker-chosen fields into config.json.
  const allowedTop = new Set(["analysis", "notes"]);
  const filteredBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (allowedTop.has(k)) filteredBody[k] = v;
  }

  const merged = {
    ...current,
    ...filteredBody,
    analysis: { ...current.analysis, ...(body.analysis ?? {}) },
    notes: { ...current.notes, ...(body.notes ?? {}) },
  };
  saveConfig(merged);
  return c.json({ ok: true, config: merged });
});

// GET /api/system — version, hooks, db path, links
configRoutes.get("/system", (c) => {
  // Version
  const version = "0.1.0";

  // Hook status (same pattern as cli/status.ts)
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let hooksInstalled = false;
  const hookDetails: Record<string, boolean> = {
    SessionStart: false,
    Stop: false,
    PostCompact: false,
    SessionEnd: false,
  };
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const hooks = settings.hooks || {};
      hookDetails.SessionStart = !!hooks.SessionStart?.length;
      hookDetails.Stop = !!hooks.Stop?.length;
      hookDetails.PostCompact = !!hooks.PostCompact?.length;
      hookDetails.SessionEnd = !!hooks.SessionEnd?.length;
      hooksInstalled = hookDetails.SessionStart && hookDetails.Stop && hookDetails.SessionEnd;
    } catch { /* ignore */ }
  }

  const dbPath = join(homedir(), ".keddy", "keddy.db");

  return c.json({
    version,
    hooksInstalled,
    hookDetails,
    dbPath,
    github: "https://github.com/emiraksay/keddy",
    npm: "https://www.npmjs.com/package/keddy",
  });
});

// DELETE /api/data — clear all session data
configRoutes.delete("/data", (c) => {
  const db = getDb();
  const tables = [
    "tool_calls", "decisions", "session_links", "session_notes",
    "daily_notes", "milestones", "segments", "plans",
    "compaction_events", "exchanges", "sessions",
  ];
  for (const table of tables) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* ignore */ }
  }
  db.exec("VACUUM");
  return c.json({ ok: true });
});

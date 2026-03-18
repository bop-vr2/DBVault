// server.js — DBVault Railway service
// Receives dump/restore jobs from Google Apps Script
// Runs mysqldump/mysql natively — no time limit, no memory limit

import express        from "express";
import { dumpDatabase }    from "./dumper.js";
import { restoreDatabase } from "./restorer.js";
import logger              from "./logger.js";

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security ──────────────────────────────────────────────────
// Apps Script sends this secret in every request header.
// Set WEBHOOK_SECRET in Railway environment variables.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  logger.error("WEBHOOK_SECRET env var is not set — requests will be rejected");
}

function auth(req, res, next) {
  const secret = req.headers["x-dbvault-secret"];
  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    logger.warn(`Unauthorised request from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorised" });
  }
  next();
}

app.use(express.json());

// ── Health check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "dbvault-railway", ts: new Date().toISOString() });
});

// ── POST /dump ────────────────────────────────────────────────
//
// Body (JSON):
// {
//   "project":      "ACME",
//   "dbName":       "catalog_db",
//   "host":         "mysql-xxx.aivencloud.com",
//   "port":         12345,
//   "user":         "ACME_DUMP_production",
//   "password":     "...",
//   "gdriveRootId": "1A2B3C...",
//   "sslCa":        "..."   // optional: Aiven CA cert content as string
// }
//
// Response (immediately, before dump completes):
// { "status": "started", "job": "catalog_db_2025-03-17_0400" }
//
// The dump runs async — Apps Script does not wait for it.
// Results are written to the Drive log file.
//
app.post("/dump", auth, (req, res) => {
  const { project, dbName, host, port, user, password, gdriveRootId, sslCa } = req.body;

  if (!project || !dbName || !host || !user || !password || !gdriveRootId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const jobId = `${dbName}_${Date.now()}`;
  logger.info(`DUMP job received: ${project}/${dbName} (job: ${jobId})`);

  // Respond immediately — don't make Apps Script wait 40 minutes
  res.json({ status: "started", job: jobId, project, dbName });

  // Run async — Railway keeps running after response is sent
  dumpDatabase({ project, dbName, host, port, user, password, gdriveRootId, sslCa })
    .then(result => {
      logger.info(`DUMP done: ${project}/${dbName} → ${result.fileName} (${(result.sizeBytes/1024/1024).toFixed(1)} MB)`);
    })
    .catch(err => {
      logger.error(`DUMP failed: ${project}/${dbName} — ${err.message}`);
    });
});

// ── POST /restore ─────────────────────────────────────────────
//
// Body (JSON):
// {
//   "project":      "ACME",
//   "dbName":       "catalog_db",
//   "host":         "mysql-xxx.aivencloud.com",
//   "port":         12345,
//   "user":         "ACME_RESTORE_backup",
//   "password":     "...",
//   "gdriveRootId": "1A2B3C...",
//   "fileId":       "1XyZ..."   // Drive file ID, or "latest"
// }
//
// Restore runs synchronously and waits for completion before responding.
// This is intentional — the UI needs to know when restore is done.
//
app.post("/restore", auth, async (req, res) => {
  const { project, dbName, host, port, user, password, gdriveRootId, fileId, sslCa } = req.body;

  if (!project || !dbName || !host || !user || !password || !gdriveRootId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  logger.info(`RESTORE job received: ${project}/${dbName} fileId=${fileId || "latest"}`);

  try {
    const result = await restoreDatabase({
      project, dbName, host, port, user, password, gdriveRootId, fileId, sslCa
    });
    res.json({ status: "ok", ...result });
  } catch (err) {
    logger.error(`RESTORE failed: ${project}/${dbName} — ${err.message}`);
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── POST /list-dumps ──────────────────────────────────────────
// Returns available dumps for a project/database (used by restore UI)
app.post("/list-dumps", auth, async (req, res) => {
  const { project, dbName, gdriveRootId } = req.body;
  if (!project || !dbName || !gdriveRootId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const { getOrCreateFolder, listDumps } = await import("./drive.js");
    const projId = await getOrCreateFolder(project, gdriveRootId);
    const dbId   = await getOrCreateFolder(dbName,  projId);
    const dumps  = await listDumps(dbId);
    res.json({ status: "ok", dumps });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`DBVault Railway service running on port ${PORT}`);
  logger.info(`mysqldump version check…`);

  import("child_process").then(({ execSync }) => {
    try {
      const v = execSync("mysqldump --version").toString().trim();
      logger.info(v);
    } catch (e) {
      logger.error("mysqldump not found — check Dockerfile");
    }
  });
});

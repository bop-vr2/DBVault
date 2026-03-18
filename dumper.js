// dumper.js — runs mysqldump natively against Aiven
// Streams gzipped output directly to Google Drive (no temp file needed)
// Works for databases of any size — no time limit, no memory limit

import { spawn }           from "child_process";
import { createGzip }      from "zlib";
import { getOrCreateFolder, uploadStream, appendLog } from "./drive.js";
import logger              from "./logger.js";

/**
 * Dumps a single database and uploads to Google Drive.
 *
 * @param {object} opts
 *   project       — project name (e.g. "ACME")
 *   dbName        — database name (e.g. "catalog_db")
 *   host          — Aiven MySQL host
 *   port          — Aiven MySQL port (usually 3306 or custom)
 *   user          — DUMP user (PROJECT_DUMP_production)
 *   password      — dump user password
 *   gdrivRootId   — root Drive folder ID
 *   sslCa         — path or content of Aiven CA certificate (optional)
 *
 * @returns {object} { fileName, sizeBytes, durationMs }
 */
export async function dumpDatabase(opts) {
  const { project, dbName, host, port, user, password, gdriveRootId, sslCa } = opts;

  const ts       = timestamp();
  const fileName = `${dbName}_${ts}.sql.gz`;
  const start    = Date.now();

  logger.info(`[${project}/${dbName}] Starting dump → ${fileName}`);

  // ── Build mysqldump command ─────────────────────────────────
  //
  //  --single-transaction   consistent snapshot without locking (InnoDB)
  //  --routines             include stored procedures + functions
  //  --triggers             include triggers (default on, but explicit)
  //  --events               include scheduled events
  //  --hex-blob             dump BLOB columns as hex (safe for binary data)
  //  --set-gtid-purged=OFF  avoid GTID errors when restoring to a different server
  //  --no-tablespaces       avoid PROCESS privilege requirement on MySQL 8.0+
  //  --ssl-ca               Aiven requires SSL — pass the CA cert path
  //
  const args = [
    `--host=${host}`,
    `--port=${port || 3306}`,
    `--user=${user}`,
    `--password=${password}`,
    "--single-transaction",
    "--routines",
    "--triggers",
    "--events",
    "--hex-blob",
    "--set-gtid-purged=OFF",
    "--no-tablespaces",
    "--compress",               // compress the client/server protocol
    "--default-character-set=utf8mb4",
  ];

  // Aiven always requires SSL
  if (sslCa) {
    args.push(`--ssl-ca=${sslCa}`);
    args.push("--ssl-mode=VERIFY_CA");
  } else {
    // If no CA provided, still use SSL (Aiven rejects non-SSL connections)
    args.push("--ssl-mode=REQUIRED");
  }

  args.push(dbName);

  // ── Get or create Drive folder ──────────────────────────────
  const projFolderId = await getOrCreateFolder(project,  gdriveRootId);
  const dbFolderId   = await getOrCreateFolder(dbName,   projFolderId);

  // ── Spawn mysqldump and pipe through gzip to Drive ──────────
  //
  // Stream pipeline:  mysqldump stdout → gzip → Drive upload
  // Nothing is written to disk — entire dump streams in memory chunks
  //
  const mysqldump = spawn("mysqldump", args, {
    env: { ...process.env, MYSQL_PWD: password }, // avoid password in process list
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Capture stderr for error reporting
  let stderrOutput = "";
  mysqldump.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  // Pipe stdout through gzip
  const gzip   = createGzip({ level: 6 }); // level 6 = good balance speed/size
  const stream = mysqldump.stdout.pipe(gzip);

  // Upload the gzipped stream to Drive
  let uploadedFile;
  try {
    uploadedFile = await uploadStream(fileName, dbFolderId, stream, "application/gzip");
  } catch (err) {
    mysqldump.kill();
    throw new Error(`Drive upload failed: ${err.message}`);
  }

  // Wait for mysqldump process to exit
  const exitCode = await new Promise((resolve, reject) => {
    mysqldump.on("close", resolve);
    mysqldump.on("error", reject);
  });

  if (exitCode !== 0) {
    throw new Error(`mysqldump exited with code ${exitCode}. stderr: ${stderrOutput}`);
  }

  const durationMs = Date.now() - start;
  const sizeBytes  = parseInt(uploadedFile.size || 0, 10);

  logger.info(
    `[${project}/${dbName}] Dump complete — ` +
    `${(sizeBytes / 1024 / 1024).toFixed(1)} MB — ` +
    `${(durationMs / 1000).toFixed(1)}s`
  );

  await appendLog(projFolderId,
    `DUMP OK ${dbName} → ${fileName} ` +
    `(${(sizeBytes/1024/1024).toFixed(1)} MB, ${(durationMs/1000).toFixed(1)}s)`
  );

  return { fileName, fileId: uploadedFile.id, sizeBytes, durationMs };
}

function timestamp() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

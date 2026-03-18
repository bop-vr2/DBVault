// restorer.js — downloads dump from Drive, restores via mysql client
// Uses streaming — no temp files, works for any size

import { spawn }                        from "child_process";
import { createGunzip }                 from "zlib";
import { getOrCreateFolder, listDumps,
         downloadStream, appendLog }    from "./drive.js";
import logger                           from "./logger.js";

/**
 * Restores a database backup from Google Drive.
 *
 * @param {object} opts
 *   project       — project name
 *   dbName        — source database name (e.g. "catalog_db")
 *   host          — MySQL host
 *   port          — MySQL port
 *   user          — RESTORE user (PROJECT_RESTORE_backup)
 *   password      — restore user password
 *   gdriveRootId  — root Drive folder ID
 *   fileId        — specific Drive file ID to restore, or "latest"
 *   sslCa         — Aiven CA cert path (optional)
 *
 * @returns {object} { fileName, durationMs }
 */
export async function restoreDatabase(opts) {
  const { project, dbName, host, port, user, password,
          gdriveRootId, fileId, sslCa } = opts;

  const targetDb = `${dbName}_backup`;
  const start    = Date.now();

  // ── Find the dump file ──────────────────────────────────────
  const projFolderId = await getOrCreateFolder(project, gdriveRootId);
  const dbFolderId   = await getOrCreateFolder(dbName,  projFolderId);

  let driveFileId   = fileId;
  let driveFileName = fileId;

  if (!fileId || fileId === "latest") {
    const dumps = await listDumps(dbFolderId);
    if (!dumps.length) throw new Error(`No dumps found for ${project}/${dbName}`);
    driveFileId   = dumps[0].id;
    driveFileName = dumps[0].name;
  } else {
    // fileId was given — look up the name for logging
    const dumps = await listDumps(dbFolderId);
    const found = dumps.find(d => d.id === fileId);
    driveFileName = found ? found.name : fileId;
  }

  logger.info(`[${project}/${dbName}] Restoring ${driveFileName} → ${targetDb}`);

  // ── Build mysql command ─────────────────────────────────────
  const args = [
    `--host=${host}`,
    `--port=${port || 3306}`,
    `--user=${user}`,
    `--password=${password}`,
    "--default-character-set=utf8mb4",
  ];

  if (sslCa) {
    args.push(`--ssl-ca=${sslCa}`);
    args.push("--ssl-mode=VERIFY_CA");
  } else {
    args.push("--ssl-mode=REQUIRED");
  }

  // ── Step 1: drop + recreate the backup database ─────────────
  await _runQuery(host, port, user, password, sslCa, [
    `DROP DATABASE IF EXISTS \`${targetDb}\``,
    `CREATE DATABASE \`${targetDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  ]);

  logger.info(`[${project}/${dbName}] Backup DB recreated — streaming restore`);

  // ── Step 2: stream Drive file → gunzip → mysql ──────────────
  //
  // Pipeline: Drive download stream → gunzip → mysql stdin
  // Nothing written to disk
  //
  const dlStream = await downloadStream(driveFileId);
  const gunzip   = createGunzip();

  const mysqlArgs = [...args, targetDb];
  const mysqlProc = spawn("mysql", mysqlArgs, {
    env:   { ...process.env, MYSQL_PWD: password },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrOutput = "";
  mysqlProc.stderr.on("data", c => { stderrOutput += c.toString(); });
  mysqlProc.stdout.on("data", c => { /* discard */ });

  // Pipe: Drive → gunzip → mysql stdin
  dlStream.pipe(gunzip).pipe(mysqlProc.stdin);

  // Handle stream errors
  dlStream.on("error", err => mysqlProc.kill());
  gunzip.on("error",   err => mysqlProc.kill());

  const exitCode = await new Promise((resolve, reject) => {
    mysqlProc.on("close", resolve);
    mysqlProc.on("error", reject);
  });

  if (exitCode !== 0) {
    throw new Error(
      `mysql restore exited with code ${exitCode}. stderr: ${stderrOutput.slice(0, 500)}`
    );
  }

  const durationMs = Date.now() - start;

  logger.info(
    `[${project}/${dbName}] Restore complete → ${targetDb} ` +
    `in ${(durationMs / 1000).toFixed(1)}s`
  );

  await appendLog(projFolderId,
    `RESTORE OK ${driveFileName} → ${targetDb} (${(durationMs/1000).toFixed(1)}s)`
  );

  return { fileName: driveFileName, targetDb, durationMs };
}

// ── Internal: run plain SQL statements (no data) ──────────────
async function _runQuery(host, port, user, password, sslCa, statements) {
  const args = [
    `--host=${host}`, `--port=${port || 3306}`,
    `--user=${user}`, `--password=${password}`,
    "--default-character-set=utf8mb4",
    sslCa ? `--ssl-ca=${sslCa}` : "--ssl-mode=REQUIRED",
    "-e", statements.join("; "),
  ];

  const proc = spawn("mysql", args, {
    env:   { ...process.env, MYSQL_PWD: password },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", c => { stderr += c.toString(); });

  const code = await new Promise((res, rej) => {
    proc.on("close", res);
    proc.on("error", rej);
  });

  if (code !== 0) throw new Error(`mysql init failed (${code}): ${stderr}`);
}

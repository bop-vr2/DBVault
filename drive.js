// drive.js — Google Drive operations via service account
// The service account JSON is stored in GOOGLE_SERVICE_ACCOUNT env var

import { google } from "googleapis";
import { Readable } from "stream";

let _drive = null;

function getDrive() {
  if (_drive) return _drive;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT env var not set");

  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  _drive = google.drive({ version: "v3", auth });
  return _drive;
}

// ── Folder helpers ────────────────────────────────────────────

export async function getOrCreateFolder(name, parentId) {
  const drive = getDrive();

  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: "files(id,name)",
  });

  if (res.data.files.length > 0) return res.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });

  return created.data.id;
}

// ── Upload ────────────────────────────────────────────────────

/**
 * Uploads a readable stream (e.g. from mysqldump stdout) to Drive.
 * Returns the created file's Drive ID.
 *
 * @param {string}   fileName     e.g. "catalog_db_2025-03-17_0400.sql.gz"
 * @param {string}   folderId     Drive folder ID
 * @param {Readable} stream       readable stream of the file content
 * @param {string}   mimeType     e.g. "application/gzip" or "text/plain"
 */
export async function uploadStream(fileName, folderId, stream, mimeType = "application/gzip") {
  const drive = getDrive();

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: "id,name,size",
  });

  return res.data;
}

// ── List dumps ────────────────────────────────────────────────

/**
 * Returns all .sql.gz files in a folder, sorted newest first.
 */
export async function listDumps(folderId) {
  const drive = getDrive();

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false and name contains '.sql'`,
    orderBy: "name desc",
    fields: "files(id,name,size,createdTime)",
  });

  return res.data.files || [];
}

// ── Download ──────────────────────────────────────────────────

/**
 * Returns a readable stream of a Drive file's content.
 */
export async function downloadStream(fileId) {
  const drive = getDrive();

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  return res.data;
}

// ── Save text file (for SQL init files, logs) ─────────────────

export async function uploadText(fileName, folderId, text) {
  const stream = Readable.from([text]);
  return uploadStream(fileName, folderId, stream, "text/plain");
}

// ── Append to log file ────────────────────────────────────────

export async function appendLog(folderId, line) {
  const drive  = getDrive();
  const logName = "_dbvault_railway.log";

  // Find existing log file
  const res = await drive.files.list({
    q: `name='${logName}' and '${folderId}' in parents and trashed=false`,
    fields: "files(id)",
  });

  const ts  = new Date().toISOString();
  const row = `[${ts}] ${line}\n`;

  if (res.data.files.length > 0) {
    const fileId  = res.data.files[0].id;
    // Download existing content
    const dl = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    const existing = dl.data || "";
    // Keep last 1000 lines
    const lines = (existing + row).split("\n").slice(-1000).join("\n");
    await drive.files.update({
      fileId,
      media: { mimeType: "text/plain", body: Readable.from([lines]) },
    });
  } else {
    await uploadText(logName, folderId, row);
  }
}

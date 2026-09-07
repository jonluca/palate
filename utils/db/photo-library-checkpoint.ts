import { getDatabase } from "./core";
import { isJsonObject, isJsonString, parseJsonValue } from "../runtime-json.ts";

const CHECKPOINT_KEY = "photo_library_change_checkpoint";
const NEW_CHECKPOINT_SQL = "json_object('token', NULL, 'revision', lower(hex(randomblob(16))))";

export interface PhotoLibraryChangeCheckpoint {
  readonly token: string | null;
  readonly revision: string;
}

function parseCheckpoint(value: string): PhotoLibraryChangeCheckpoint {
  const checkpoint = parseJsonValue(value);
  if (
    !isJsonObject(checkpoint) ||
    !isJsonString(checkpoint.revision) ||
    checkpoint.revision.length === 0 ||
    (checkpoint.token !== null && !isJsonString(checkpoint.token))
  ) {
    throw new Error("Photo-library change checkpoint is malformed.");
  }
  return { token: checkpoint.token, revision: checkpoint.revision };
}

/** Read a durable checkpoint, assigning a generation to a fresh or reset database. */
export async function getPhotoLibraryChangeCheckpoint(): Promise<PhotoLibraryChangeCheckpoint> {
  const database = await getDatabase();
  let row = await database.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = ?", [
    CHECKPOINT_KEY,
  ]);
  if (!row) {
    await database.runAsync(`INSERT OR IGNORE INTO app_metadata (key, value) VALUES (?, ${NEW_CHECKPOINT_SQL})`, [
      CHECKPOINT_KEY,
    ]);
    row = await database.getFirstAsync<{ value: string }>("SELECT value FROM app_metadata WHERE key = ?", [
      CHECKPOINT_KEY,
    ]);
  }
  if (!row) {
    throw new Error("Photo-library change checkpoint could not be initialized.");
  }
  return parseCheckpoint(row.value);
}

/**
 * Advance only after all metadata pages are durable. An older prepared scan
 * cannot replace a checkpoint committed or invalidated since it was prepared.
 */
export async function commitPhotoLibraryChangeToken(token: string | null, expectedRevision: string): Promise<boolean> {
  if (token !== null && token.trim().length === 0) {
    throw new TypeError("Photo-library change token must be non-empty or null.");
  }
  if (expectedRevision.trim().length === 0) {
    throw new TypeError("Photo-library checkpoint revision must be non-empty.");
  }
  const database = await getDatabase();
  const result = await database.runAsync(
    `UPDATE app_metadata
     SET value = json_object('token', ?, 'revision', lower(hex(randomblob(16))))
     WHERE key = ? AND json_extract(value, '$.revision') = ?`,
    [token, CHECKPOINT_KEY, expectedRevision],
  );
  return result.changes === 1;
}

/** Clear history whenever local photo rows are removed or replaced independently of PhotoKit. */
export async function invalidatePhotoLibraryChangeToken(): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO app_metadata (key, value) VALUES (?, ${NEW_CHECKPOINT_SQL})
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [CHECKPOINT_KEY],
  );
}

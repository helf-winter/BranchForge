import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessError } from "../domain/errors.js";

/** SQLite snapshots include committed WAL contents; copying only runtime.db does not. */
export function backupRuntimeDatabase(source: string, target: string): string {
  const resolved = path.resolve(target);
  if (!path.isAbsolute(target) || existsSync(resolved) || resolved === realpathSync(source)) {
    throw new HarnessError("invalid_input", "backup must be a new absolute file path, not the live database");
  }
  const database = new DatabaseSync(source, { readOnly: true });
  try { database.prepare("VACUUM INTO ?").run(resolved); }
  catch (error) { throw new HarnessError("storage_failure", "could not create a consistent database backup", String(error)); }
  finally { database.close(); }
  return resolved;
}

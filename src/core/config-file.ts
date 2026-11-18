import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

function statIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

// Lock and replace the target, not the symlink. Canonicalize the parent even
// for new files so aliases use the same lock. Follow dangling links too.
function configTarget(path: string): string {
  for (let links = 0; links < 40; links++) {
    path = join(realpathSync.native(dirname(path)), basename(path));
    if (!statIfPresent(path)?.isSymbolicLink()) return path;
    const link = readlinkSync(path);
    path = isAbsolute(link) ? link : `${dirname(path)}${sep}${link}`;
  }
  throw new Error(`Too many symlinks resolving ${path}`);
}

export function readJsonConfig(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return parsed as Record<string, unknown>;
}

// The supplied path is the final target. Never follow a symlink here.
export function atomicWriteFile(path: string, content: string, newMode = 0o666): void {
  const existing = statIfPresent(path);
  if (existing && !existing.isFile()) throw new Error(`Not a regular file: ${path}`);
  const temp = join(dirname(path), `.pi-write-${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", existing ? 0o600 : newMode);
  try {
    try {
      writeFileSync(fd, content, "utf8");
      if (existing) fchmodSync(fd, existing.mode & 0o7777);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Serialize cooperating writers across the whole read/merge/publication. */
export function updateJsonConfig(
  path: string,
  update: (existing: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const target = configTarget(path);
  const lock = `${target}.lock`;
  const deadline = performance.now() + 500;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const remaining = deadline - performance.now();
      // Never steal a lock based on age or PID reuse. After a crash, an
      // abandoned lock may be removed manually once no writer is running.
      if (remaining <= 0) throw new Error(`Config is locked: ${lock}`);
      Atomics.wait(pause, 0, 0, Math.min(20, remaining));
    }
  }
  try {
    const existing = statIfPresent(target);
    if (existing && !existing.isFile()) throw new Error(`Not a regular file: ${target}`);
    const next = update(readJsonConfig(target));
    if (next !== undefined) atomicWriteFile(target, `${JSON.stringify(next, null, 2)}\n`);
  } finally {
    rmdirSync(lock);
  }
}

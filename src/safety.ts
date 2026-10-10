/**
 * Path and filename safety helpers.
 *
 * Everything the plugin writes or scans stays strictly inside a configured
 * root. The checks are deliberately local (plain `node:path` + `node:fs`)
 * so the behaviour is auditable and does not depend on host internals:
 *
 *   - filenames are reduced to a single safe segment (no separators, no `..`)
 *   - every resolved path is re-verified to be inside the root
 *   - symlinked parents are rejected so a link inside the root cannot be used
 *     to escape it
 */
import fs from "node:fs";
import path from "node:path";

/** Max length of a single filename segment we will write. */
const MAX_NAME_LENGTH = 180;

/** Characters that are invalid or unsafe in a cross-platform filename. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * Reduce an arbitrary client-supplied filename to a single safe path segment.
 * Strips directory components, control characters, and leading dots so the
 * result can never be `.`/`..` or a hidden dotfile.
 */
export function sanitizeFileName(raw: string | undefined, fallback: string): string {
  let name = (raw ?? "").trim();

  // Some clients send a Windows path or a full path in the `filename` field.
  const lastSlash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (lastSlash >= 0) {
    name = name.slice(lastSlash + 1);
  }

  name = name.replace(UNSAFE_NAME_CHARS, "_");
  name = name.replace(/^\.+/, ""); // no leading dots -> no "..", no dotfiles
  name = name.trim();

  if (name.length === 0) {
    return fallback;
  }
  if (name.length > MAX_NAME_LENGTH) {
    const ext = path.extname(name);
    const base = name.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length));
    name = `${base}${ext}`;
  }
  return name;
}

/** Sanitize a session id so it can be used as a single directory segment. */
export function sanitizeSessionSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return "default";
  }
  return cleaned.slice(0, 120);
}

/**
 * Resolve `segments` under `root` and assert the result is contained in `root`.
 * Throws `UnsafePathError` on traversal attempts.
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const rel = path.relative(resolvedRoot, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new UnsafePathError(`path escapes configured root: ${segments.join("/")}`);
  }
  return target;
}

/** True when `target` is inside `root` (root itself excluded). */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Reject a path whose existing ancestors contain a symlink.
 *
 * `fs.mkdir({recursive:true})` happily follows links, so a symlink planted
 * inside the root could otherwise redirect writes outside it. When
 * `allowSymlinkLeaf` is set, a symlink at the path itself is tolerated (the
 * root directory may legitimately be a link, e.g. a PVC mount).
 */
export function assertNoSymlinkAncestors(
  target: string,
  root: string,
  opts?: { allowSymlinkLeaf?: boolean },
): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);

  const chain: string[] = [];
  let cursor = resolvedTarget;
  while (true) {
    chain.push(cursor);
    if (cursor === resolvedRoot || cursor === path.dirname(cursor)) {
      break;
    }
    cursor = path.dirname(cursor);
  }
  chain.reverse();

  const lastIndex = chain.length - 1;
  for (let i = 0; i < chain.length; i += 1) {
    const entry = chain[i];
    if (i === lastIndex && opts?.allowSymlinkLeaf === true) {
      continue;
    }
    try {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) {
        throw new UnsafePathError(`refusing to follow symlinked path component: ${entry}`);
      }
    } catch (err) {
      if (err instanceof UnsafePathError) {
        throw err;
      }
      // ENOENT and friends: the component does not exist yet, which is fine.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

/**
 * Create `dir` (and parents) inside `root`, verifying containment first.
 * Returns the resolved absolute directory path.
 */
export function ensureDirWithin(root: string, ...segments: string[]): string {
  const target = resolveWithin(root, ...segments);
  assertNoSymlinkAncestors(target, root, { allowSymlinkLeaf: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/** POSIX-style relative path, suitable for emitting to clients. */
export function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

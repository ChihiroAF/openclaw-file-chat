export declare class UnsafePathError extends Error {
    constructor(message: string);
}
/**
 * Reduce an arbitrary client-supplied filename to a single safe path segment.
 * Strips directory components, control characters, and leading dots so the
 * result can never be `.`/`..` or a hidden dotfile.
 */
export declare function sanitizeFileName(raw: string | undefined, fallback: string): string;
/** Sanitize a session id so it can be used as a single directory segment. */
export declare function sanitizeSessionSegment(raw: string): string;
/**
 * Resolve `segments` under `root` and assert the result is contained in `root`.
 * Throws `UnsafePathError` on traversal attempts.
 */
export declare function resolveWithin(root: string, ...segments: string[]): string;
/** True when `target` is inside `root` (root itself excluded). */
export declare function isInsideRoot(root: string, target: string): boolean;
/**
 * Reject a path whose existing ancestors contain a symlink.
 *
 * `fs.mkdir({recursive:true})` happily follows links, so a symlink planted
 * inside the root could otherwise redirect writes outside it. When
 * `allowSymlinkLeaf` is set, a symlink at the path itself is tolerated (the
 * root directory may legitimately be a link, e.g. a PVC mount).
 */
export declare function assertNoSymlinkAncestors(target: string, root: string, opts?: {
    allowSymlinkLeaf?: boolean;
}): void;
/**
 * Create `dir` (and parents) inside `root`, verifying containment first.
 * Returns the resolved absolute directory path.
 */
export declare function ensureDirWithin(root: string, ...segments: string[]): string;
/** POSIX-style relative path, suitable for emitting to clients. */
export declare function toPosixRelative(from: string, to: string): string;

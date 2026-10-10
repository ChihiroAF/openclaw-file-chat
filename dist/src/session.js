/**
 * Session key derivation.
 *
 * The OpenClaw Gateway's own OpenAI-compatible endpoint resolves a session
 * key from the request (`src/gateway/http-utils.ts:245-262`):
 *
 *   header `x-openclaw-session-key`  -> use it verbatim
 *   body `user`                      -> a stable per-user session
 *   neither                          -> a fresh session per request
 *
 * This plugin follows the same convention so callers get familiar semantics,
 * but namespaces its own keys with `file-chat-` and avoids `:` separators.
 * Host-reserved namespaces (`subagent:`, `cron:`, `acp:`) are rejected up front
 * with a clear 4xx instead of failing later inside the run.
 */
import { createHash, randomUUID } from "node:crypto";
import { sanitizeSessionSegment } from "./safety.js";
const NAMESPACE = "file-chat";
/** Session-key namespaces owned by the host that callers must not claim. */
const RESERVED_PREFIXES = ["subagent:", "cron:", "acp:"];
const MAX_SESSION_KEY_LENGTH = 512;
export class InvalidSessionKeyError extends Error {
    constructor(message) {
        super(message);
        this.name = "InvalidSessionKeyError";
    }
}
export function assertSessionKeyAllowed(sessionKey) {
    const trimmed = sessionKey.trim();
    if (trimmed.length === 0) {
        throw new InvalidSessionKeyError("sessionKey must not be empty");
    }
    if (trimmed.length > MAX_SESSION_KEY_LENGTH) {
        throw new InvalidSessionKeyError(`sessionKey must be at most ${MAX_SESSION_KEY_LENGTH} characters`);
    }
    const lower = trimmed.toLowerCase();
    for (const prefix of RESERVED_PREFIXES) {
        if (lower.startsWith(prefix)) {
            throw new InvalidSessionKeyError(`sessionKey namespace "${prefix}" is reserved`);
        }
    }
    return trimmed;
}
/**
 * Resolve the session key for a request.
 *
 * Priority: explicit `sessionKey` > `x-openclaw-session-key` header > `user`
 * (stable per user) > fresh random session.
 */
export function resolveSessionKey(params) {
    const explicit = params.bodySessionKey?.trim() || params.headerSessionKey?.trim();
    if (explicit) {
        return { sessionKey: assertSessionKeyAllowed(explicit), generated: false };
    }
    const user = params.user?.trim();
    if (user) {
        return {
            sessionKey: `${NAMESPACE}-user-${stableSegment(user)}`,
            generated: false,
        };
    }
    return { sessionKey: `${NAMESPACE}-${randomUUID()}`, generated: true };
}
/**
 * Turn a free-form identifier into a filesystem-safe, collision-resistant
 * directory segment. When sanitization changes the input we append a short
 * hash so two distinct session keys can never share one directory.
 */
export function sessionDirSegment(sessionKey) {
    const sanitized = sanitizeSessionSegment(sessionKey);
    if (sanitized === sessionKey) {
        return sanitized;
    }
    const digest = createHash("sha1").update(sessionKey).digest("hex").slice(0, 8);
    return `${sanitized.slice(0, 100)}-${digest}`;
}
function stableSegment(value) {
    const sanitized = sanitizeSessionSegment(value);
    if (sanitized === value) {
        return sanitized;
    }
    return `${sanitized.slice(0, 80)}-${createHash("sha1").update(value).digest("hex").slice(0, 8)}`;
}

import type { FileChatConfig } from "./config.js";
import { UnsafePathError } from "./safety.js";
export type FileChatLogger = {
    info?(msg: string, ...args: unknown[]): void;
    warn?(msg: string, ...args: unknown[]): void;
    error?(msg: string, ...args: unknown[]): void;
    debug?(msg: string, ...args: unknown[]): void;
};
/** One attached file as supplied by the client. */
export type InboundInput = {
    name?: string;
    mimeType?: string;
    /** Raw base64 or a `data:<mime>;base64,<data>` URL. */
    base64?: string;
    /** Remote download URL, fetched through the host SSRF guard. */
    url?: string;
};
/** One attached file after it has been persisted. */
export type InboundFile = {
    name: string;
    mimeType?: string;
    size: number;
    /** POSIX path relative to `filesRoot`, e.g. `inbound/<sid>/a.pdf`. */
    path: string;
    absolutePath: string;
    source: "base64" | "url";
    sourceUrl?: string;
};
/** One file found in the outbound directory. */
export type OutboundFile = {
    /** Basename of the file. */
    name: string;
    size: number;
    /** ISO timestamp of last modification. */
    modifiedAt: string;
    /** POSIX path relative to `filesRoot`, e.g. `outbound/<sid>/report.md`. */
    path: string;
    absolutePath: string;
};
export declare class FileChatFileError extends Error {
    constructor(message: string);
}
/**
 * Resolve (and create) the directory holding inbound files for one session.
 * Returns the absolute path and its POSIX-relative form under `root`.
 */
export declare function resolveInboundDir(cfg: FileChatConfig, sessionKey: string): {
    absolute: string;
    relative: string;
};
/** Resolve (and create) the directory holding outbound files for one session. */
export declare function resolveOutboundDir(cfg: FileChatConfig, sessionKey: string): {
    absolute: string;
    relative: string;
};
/**
 * Persist every attached file, one by one, into the session's inbound
 * directory. A per-file failure is reported in the result instead of aborting
 * the whole request, so a bad URL does not lose the user's message.
 */
export declare function saveInboundFiles(params: {
    cfg: FileChatConfig;
    sessionKey: string;
    inputs: InboundInput[];
    logger?: FileChatLogger;
    signal?: AbortSignal;
}): Promise<{
    files: InboundFile[];
    failures: Array<{
        name: string;
        error: string;
    }>;
}>;
/** Snapshot entry for one outbound file. */
export type OutboundEntry = {
    size: number;
    mtimeMs: number;
};
/** Snapshot of outbound files, keyed by POSIX-relative path. */
export type OutboundSnapshot = Map<string, OutboundEntry>;
export declare function snapshotOutbound(cfg: FileChatConfig, sessionKey: string): OutboundSnapshot;
/** Files reported after a run: everything new or changed since the snapshot. */
export declare function diffOutbound(cfg: FileChatConfig, sessionKey: string, before: OutboundSnapshot): OutboundFile[];
export { UnsafePathError };

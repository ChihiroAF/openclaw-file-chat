/**
 * Configuration for the file-chat plugin.
 *
 * Settings are read from the plugin's config block in `openclaw.json`, i.e.
 * `plugins.entries["file-chat"].config` (or the flat `plugins["file-chat"]`
 * form on older configs):
 *
 * ```json
 * {
 *   "plugins": {
 *     "entries": {
 *       "file-chat": {
 *         "enabled": true,
 *         "config": {
 *           "path": "/api/v1/file-chat",
 *           "filesRoot": "/home/node/.openclaw/file-chat/files"
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Authentication is NOT configured here: the route is registered with
 * `auth: "gateway"`, so the gateway's own HTTP auth (Bearer token / password /
 * trusted-proxy) protects it before the handler ever runs. There is
 * deliberately no plugin-level API key — see README "认证".
 */
import os from "node:os";
import path from "node:path";
export const DEFAULT_PATH = "/api/v1/file-chat";
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_FILES_PER_REQUEST = 10;
/** Placeholder substituted with the absolute outbound directory. */
export const OUTBOUND_DIR_PLACEHOLDER = "{{outboundDir}}";
/** Placeholder substituted with the session-scoped relative outbound prefix. */
export const OUTBOUND_REL_PLACEHOLDER = "{{outboundRel}}";
const DEFAULT_OUTBOUND_INSTRUCTION = [
    "## File I/O contract (file-chat)",
    "",
    "This endpoint supports files in both directions.",
    "",
    "Inbound: files attached by the user are already saved on disk. Their absolute paths are listed in the user message under `[file-chat inbound files]`. Read them with your file tools when relevant.",
    "",
    "Outbound: when you produce a file for the user (report, spreadsheet, image, archive, ...), write it into this directory (it already exists, so write directly):",
    "",
    `  ${OUTBOUND_DIR_PLACEHOLDER}`,
    "",
    "Rules for outbound files:",
    `1. Use a descriptive filename with the correct extension.`,
    `2. When you mention a generated file in your reply, use only the relative path \`${OUTBOUND_REL_PLACEHOLDER}/<filename>\` — never the absolute path.`,
    `3. Do not invent file paths. Only reference files you actually wrote.`,
].join("\n");
function asNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function asPositiveInt(value, fallback, min) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < min) {
        return fallback;
    }
    return Math.floor(parsed);
}
function expandHome(input) {
    if (input === "~") {
        return os.homedir();
    }
    if (input.startsWith("~/") || input.startsWith("~\\")) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}
export function defaultFilesRoot() {
    return path.join(os.homedir(), ".openclaw", "file-chat", "files");
}
export function resolveFileChatConfig({ pluginConfig, }) {
    const cfg = pluginConfig ?? {};
    const rawPath = asNonEmptyString(cfg.path);
    const routePath = rawPath && rawPath.startsWith("/") ? rawPath : DEFAULT_PATH;
    const filesRootRaw = asNonEmptyString(cfg.filesRoot);
    const filesRoot = filesRootRaw
        ? path.resolve(expandHome(filesRootRaw))
        : defaultFilesRoot();
    // Keep these as single safe path segments.
    const inboundDirName = sanitizeDirName(asNonEmptyString(cfg.inboundDirName) ?? "inbound", "inbound");
    const outboundDirName = sanitizeDirName(asNonEmptyString(cfg.outboundDirName) ?? "outbound", "outbound");
    return {
        path: routePath,
        filesRoot,
        inboundDirName,
        outboundDirName,
        sessionScopedDirs: cfg.sessionScopedDirs !== false,
        publicPathPrefix: asNonEmptyString(cfg.publicPathPrefix) ?? "",
        maxFileBytes: asPositiveInt(cfg.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1024),
        maxFilesPerRequest: asPositiveInt(cfg.maxFilesPerRequest, DEFAULT_MAX_FILES_PER_REQUEST, 1),
        allowUrlFetch: cfg.allowUrlFetch !== false,
        appendOutboundFooter: cfg.appendOutboundFooter !== false,
        defaultProvider: asNonEmptyString(cfg.defaultProvider),
        defaultModel: asNonEmptyString(cfg.defaultModel),
        defaultThinking: asNonEmptyString(cfg.defaultThinking),
        outboundInstruction: asNonEmptyString(cfg.outboundInstruction) ?? DEFAULT_OUTBOUND_INSTRUCTION,
    };
}
/** Reduces an arbitrary string to a single safe directory segment. */
function sanitizeDirName(value, fallback) {
    const cleaned = value.replace(/[\\/]/g, "").replace(/[\u0000-\u001f]/g, "").trim();
    if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
        return fallback;
    }
    return cleaned;
}

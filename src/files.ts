/**
 * Inbound file storage and outbound directory scanning.
 *
 * Inbound: the plugin (not the model) writes uploaded bytes to disk. This
 * keeps the path contract explicit and works for every MIME type, not just
 * images — the host's own `AgentCommandOpts` only carries `images` for inline
 * multimodal input (`src/agents/command/types.ts`).
 *
 * Outbound: because the host strips local paths from structured media blocks
 * (`MEDIA_PRIVATE_FIELDS`) and there is no channel to enumerate produced
 * files, the plugin snapshots the session's outbound directory before the run
 * and again afterwards. New or changed entries are reported back to the
 * caller. This needs no model cooperation to *detect*; the model only has to
 * write into the right directory, which is stated in the system prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { FileChatConfig } from "./config.js";
import {
  assertNoSymlinkAncestors,
  ensureDirWithin,
  resolveWithin,
  sanitizeFileName,
  toPosixRelative,
  UnsafePathError,
} from "./safety.js";
import { sessionDirSegment } from "./session.js";

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

export class FileChatFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileChatFileError";
  }
}

const URL_FETCH_TIMEOUT_MS = 60_000;
const OUTBOUND_SCAN_MAX_DEPTH = 6;
const OUTBOUND_SCAN_MAX_ENTRIES = 2000;

/** Extension hints for the common cases where only a MIME type is known. */
const MIME_EXTENSION: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/html": ".html",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
};

/**
 * Resolve (and create) the directory holding inbound files for one session.
 * Returns the absolute path and its POSIX-relative form under `root`.
 */
export function resolveInboundDir(
  cfg: FileChatConfig,
  sessionKey: string,
): { absolute: string; relative: string } {
  const root = path.resolve(cfg.filesRoot);
  const segments = cfg.sessionScopedDirs
    ? [cfg.inboundDirName, sessionDirSegment(sessionKey)]
    : [cfg.inboundDirName];
  const absolute = ensureDirWithin(root, ...segments);
  return { absolute, relative: toPosixRelative(root, absolute) };
}

/** Resolve (and create) the directory holding outbound files for one session. */
export function resolveOutboundDir(
  cfg: FileChatConfig,
  sessionKey: string,
): { absolute: string; relative: string } {
  const root = path.resolve(cfg.filesRoot);
  const segments = cfg.sessionScopedDirs
    ? [cfg.outboundDirName, sessionDirSegment(sessionKey)]
    : [cfg.outboundDirName];
  const absolute = ensureDirWithin(root, ...segments);
  return { absolute, relative: toPosixRelative(root, absolute) };
}

/**
 * Persist every attached file, one by one, into the session's inbound
 * directory. A per-file failure is reported in the result instead of aborting
 * the whole request, so a bad URL does not lose the user's message.
 */
export async function saveInboundFiles(params: {
  cfg: FileChatConfig;
  sessionKey: string;
  inputs: InboundInput[];
  logger?: FileChatLogger;
  signal?: AbortSignal;
}): Promise<{ files: InboundFile[]; failures: Array<{ name: string; error: string }> }> {
  const { cfg, inputs, logger } = params;
  const root = path.resolve(cfg.filesRoot);
  const files: InboundFile[] = [];
  const failures: Array<{ name: string; error: string }> = [];

  if (inputs.length === 0) {
    return { files, failures };
  }
  if (inputs.length > cfg.maxFilesPerRequest) {
    throw new FileChatFileError(
      `too many files: ${inputs.length} (limit ${cfg.maxFilesPerRequest})`,
    );
  }

  // Resolve once, then reuse the directory for every file.
  const dir = resolveInboundDir(cfg, params.sessionKey).absolute;
  const usedNames = new Set<string>();

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const label = input.name?.trim() || `file-${index + 1}`;

    let buffer: Buffer;
    let mimeType = input.mimeType?.trim() || undefined;
    let source: "base64" | "url" = "base64";

    try {
      if (input.base64) {
        const decoded = decodeBase64Payload(input.base64);
        buffer = decoded.buffer;
        mimeType = mimeType ?? decoded.mimeType;
      } else if (input.url) {
        if (!cfg.allowUrlFetch) {
          throw new FileChatFileError("url fetch is disabled on this endpoint");
        }
        const fetched = await fetchRemoteFile({
          url: input.url,
          maxBytes: cfg.maxFileBytes,
          signal: params.signal,
        });
        buffer = fetched.buffer;
        mimeType = mimeType ?? fetched.mimeType;
        source = "url";
      } else {
        throw new FileChatFileError(`file ${label}: provide either "content" (base64) or "url"`);
      }

      if (buffer.length > cfg.maxFileBytes) {
        throw new FileChatFileError(
          `file ${label}: ${buffer.length} bytes exceeds limit ${cfg.maxFileBytes}`,
        );
      }

      const name = uniqueName(
        sanitizeFileName(ensureExtension(input.name?.trim(), mimeType), `file-${index + 1}.bin`),
        usedNames,
      );
      // `name` is already a single sanitized segment, so this can only ever
      // resolve to <inbound dir>/<name>.
      const absolutePath = resolveWithin(root, toPosixRelative(root, dir), name);
      assertNoSymlinkAncestors(absolutePath, root, { allowSymlinkLeaf: true });
      fs.writeFileSync(absolutePath, buffer);

      usedNames.add(name);
      files.push({
        name,
        mimeType,
        size: buffer.length,
        path: toPosixRelative(root, absolutePath),
        absolutePath,
        source,
        ...(input.url ? { sourceUrl: input.url } : {}),
      });
      logger?.info?.(`[file-chat] inbound saved ${absolutePath} (${buffer.length} bytes)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ name: label, error: message });
      logger?.warn?.(`[file-chat] inbound failed for ${label}: ${message}`);
    }
  }

  return { files, failures };
}

/** Snapshot entry for one outbound file. */
export type OutboundEntry = { size: number; mtimeMs: number };

/** Snapshot of outbound files, keyed by POSIX-relative path. */
export type OutboundSnapshot = Map<string, OutboundEntry>;

export function snapshotOutbound(cfg: FileChatConfig, sessionKey: string): OutboundSnapshot {
  const snapshot: OutboundSnapshot = new Map();
  const { absolute, relative } = resolveOutboundDir(cfg, sessionKey);
  walkDir(absolute, relative, snapshot, 0);
  return snapshot;
}

/** Files reported after a run: everything new or changed since the snapshot. */
export function diffOutbound(
  cfg: FileChatConfig,
  sessionKey: string,
  before: OutboundSnapshot,
): OutboundFile[] {
  const after = snapshotOutbound(cfg, sessionKey);
  const root = path.resolve(cfg.filesRoot);
  const changed: OutboundFile[] = [];

  for (const [relative, info] of after) {
    const previous = before.get(relative);
    if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
      continue;
    }
    const absolutePath = resolveWithin(root, relative);
    changed.push({
      name: path.posix.basename(relative),
      size: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      path: relative,
      absolutePath,
    });
  }

  changed.sort((a, b) => a.path.localeCompare(b.path));
  return changed;
}

function walkDir(
  dir: string,
  relativeDir: string,
  out: OutboundSnapshot,
  depth: number,
): void {
  if (depth > OUTBOUND_SCAN_MAX_DEPTH || out.size >= OUTBOUND_SCAN_MAX_ENTRIES) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.size >= OUTBOUND_SCAN_MAX_ENTRIES) {
      return;
    }
    if (entry.name.startsWith(".")) {
      continue;
    }
    const absoluteChild = path.join(dir, entry.name);
    const relativeChild = `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      walkDir(absoluteChild, relativeChild, out, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    try {
      const stat = fs.statSync(absoluteChild);
      out.set(relativeChild, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
    } catch {
      // File vanished between readdir and stat; ignore.
    }
  }
}

function decodeBase64Payload(raw: string): { buffer: Buffer; mimeType?: string } {
  let payload = raw.trim();
  let mimeType: string | undefined;

  const commaIndex = payload.indexOf(",");
  if (commaIndex >= 0) {
    const head = payload.slice(0, commaIndex);
    if (/^data:[^;,]+;base64$/i.test(head)) {
      mimeType = head.slice("data:".length, -";base64".length).toLowerCase();
      payload = payload.slice(commaIndex + 1);
    }
  }

  payload = payload.replace(/\s+/g, "");
  if (payload.length === 0) {
    throw new FileChatFileError("base64 content is empty");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new FileChatFileError("content is not valid base64");
  }
  return { buffer: Buffer.from(payload, "base64"), mimeType };
}

async function fetchRemoteFile(params: {
  url: string;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<{ buffer: Buffer; mimeType?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    throw new FileChatFileError("url is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FileChatFileError(`url protocol not allowed: ${parsed.protocol}`);
  }

  // No explicit policy => the host guard applies its default: private and
  // loopback targets are blocked, redirects are bounded. That is exactly the
  // behaviour wanted for a client-supplied download link.
  const { response, release } = await fetchWithSsrFGuard({
    url: parsed.toString(),
    init: { method: "GET" },
    timeoutMs: URL_FETCH_TIMEOUT_MS,
    signal: params.signal,
    maxRedirects: 3,
    auditContext: "file-chat.inbound_fetch",
  });

  try {
    if (!response.ok) {
      throw new FileChatFileError(`url fetch failed: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > params.maxBytes) {
      throw new FileChatFileError(
        `url content-length ${declared} exceeds limit ${params.maxBytes}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > params.maxBytes) {
      throw new FileChatFileError(`url body ${buffer.length} exceeds limit ${params.maxBytes}`);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
    return { buffer, mimeType: contentType || undefined };
  } finally {
    await release().catch(() => undefined);
  }
}

/** Append a MIME-derived extension when the supplied name has none. */
function ensureExtension(name: string | undefined, mimeType: string | undefined): string {
  const base = (name ?? "").trim();
  if (base.length === 0) {
    const ext = mimeType ? MIME_EXTENSION[mimeType.toLowerCase()] : undefined;
    return ext ? `file${ext}` : "";
  }
  if (path.extname(base).length > 1) {
    return base;
  }
  const ext = mimeType ? MIME_EXTENSION[mimeType.toLowerCase()] : undefined;
  return ext ? `${base}${ext}` : base;
}

/** De-duplicate names within one request: `a.pdf`, `a-2.pdf`, `a-3.pdf`. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    return name;
  }
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `${createHash("sha1").update(name).digest("hex").slice(0, 8)}${ext}`;
}

export { UnsafePathError };

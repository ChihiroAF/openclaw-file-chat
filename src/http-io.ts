/**
 * HTTP input parsing and response helpers.
 *
 * Two request shapes are accepted so the endpoint stays convenient for both
 * styles of caller:
 *
 *   1. `application/json`  — the OpenAI-flavoured shape, files inline as
 *      base64 (`content`) or as a download link (`url`).
 *   2. `multipart/form-data` — ordinary browser upload, with a `message`
 *      field plus any number of `files` parts.
 *
 * Multipart parsing uses the platform `FormData` parser (available for a
 * `Response` body since Node 18) so no third-party parser is needed.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InboundInput } from "./files.js";

/** Hard cap on the raw request body, independent of the per-file limit. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

const MAX_TEXT_FIELD_LENGTH = 512;

export type ParsedRequest = {
  message: string;
  agentId?: string;
  sessionKey?: string;
  user?: string;
  thinking?: string;
  provider?: string;
  model?: string;
  stream: boolean;
  files: InboundInput[];
};

export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        reject(
          new RequestBodyError(
            `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
            413,
          ),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function parseRequestBody(
  req: IncomingMessage,
  raw: Buffer,
): Promise<ParsedRequest> {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    return await parseMultipart(contentType, String(req.headers["content-type"]), raw);
  }
  return parseJsonRequest(raw);
}

function parseJsonRequest(raw: Buffer): ParsedRequest {
  const text = raw.toString("utf-8").trim();
  if (text.length === 0) {
    throw new RequestBodyError("request body is empty; expected a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RequestBodyError(
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestBodyError("request body must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;

  const message = typeof body.message === "string" ? body.message : "";
  if (message.trim().length === 0) {
    throw new RequestBodyError("message is required and must be a non-empty string");
  }

  const files: InboundInput[] = [];
  const rawFiles = body.files ?? body.attachments;
  if (Array.isArray(rawFiles)) {
    for (const entry of rawFiles) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const base64 =
        pickString(record.content) ??
        pickString(record.base64) ??
        pickString(record.data) ??
        pickString(record.file_data);
      const url = pickString(record.url);
      files.push({
        name: pickString(record.name) ?? pickString(record.filename) ?? pickString(record.fileName),
        mimeType: pickString(record.mimeType) ?? pickString(record.mime_type),
        ...(base64 ? { base64 } : {}),
        ...(url ? { url } : {}),
      });
    }
  }

  // Convenience: a list of download links without file metadata.
  const rawUrls = body.urls;
  if (Array.isArray(rawUrls)) {
    for (const entry of rawUrls) {
      const url = pickString(entry);
      if (url) {
        files.push({ url });
      }
    }
  }

  return {
    message: message.trim(),
    agentId: pickString(body.agentId),
    sessionKey: pickString(body.sessionKey),
    user: pickString(body.user),
    thinking: pickString(body.thinking),
    provider: pickString(body.provider),
    model: pickString(body.model),
    stream: body.stream === undefined ? true : body.stream !== false,
    files,
  };
}

async function parseMultipart(
  contentTypeLower: string,
  contentTypeRaw: string,
  raw: Buffer,
): Promise<ParsedRequest> {
  if (!contentTypeLower.includes("boundary=")) {
    throw new RequestBodyError("multipart body is missing a boundary");
  }

  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), {
      headers: { "content-type": contentTypeRaw },
    }).formData();
  } catch (err) {
    throw new RequestBodyError(
      `invalid multipart body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const message = valueOf(form.get("message")) ?? "";
  if (message.trim().length === 0) {
    throw new RequestBodyError("message is required and must be a non-empty string");
  }

  const files: InboundInput[] = [];
  for (const key of ["files", "file", "files[]", "attachments"]) {
    for (const value of form.getAll(key)) {
      if (!(value instanceof Blob)) {
        continue;
      }
      const name = value instanceof File ? value.name : undefined;
      const mimeType = value.type || undefined;
      const buffer = Buffer.from(await value.arrayBuffer());
      files.push({
        name,
        mimeType,
        base64: buffer.toString("base64"),
      });
    }
  }

  // Text field carrying download links (JSON array or one per line).
  const rawUrls = valueOf(form.get("urls"));
  if (rawUrls) {
    for (const url of splitUrls(rawUrls)) {
      files.push({ url });
    }
  }

  return {
    message: message.trim(),
    agentId: shortField(valueOf(form.get("agentId"))),
    sessionKey: shortField(valueOf(form.get("sessionKey"))),
    user: shortField(valueOf(form.get("user"))),
    thinking: shortField(valueOf(form.get("thinking"))),
    provider: shortField(valueOf(form.get("provider"))),
    model: shortField(valueOf(form.get("model"))),
    stream: valueOf(form.get("stream")) !== "false",
    files,
  };
}

function splitUrls(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read a text value out of a multipart entry.
 *
 * Declared over `unknown` because `FormDataEntryValue` is a DOM lib type and
 * this project compiles with `lib: ["ES2023"]` only.
 */
function valueOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function shortField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > MAX_TEXT_FIELD_LENGTH
    ? trimmed.slice(0, MAX_TEXT_FIELD_LENGTH)
    : trimmed;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.statusCode = status;
  if (!res.headersSent) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.end(JSON.stringify(payload));
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    ok: false,
    error: { message, type: "invalid_request_error", code: status },
  });
}

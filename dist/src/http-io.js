/** Hard cap on the raw request body, independent of the per-file limit. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_FIELD_LENGTH = 512;
export class RequestBodyError extends Error {
    statusCode;
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
        this.name = "RequestBodyError";
    }
}
export async function readRawBody(req) {
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > MAX_REQUEST_BODY_BYTES) {
                reject(new RequestBodyError(`request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`, 413));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
export async function parseRequestBody(req, raw) {
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
        return await parseMultipart(contentType, String(req.headers["content-type"]), raw);
    }
    return parseJsonRequest(raw);
}
function parseJsonRequest(raw) {
    const text = raw.toString("utf-8").trim();
    if (text.length === 0) {
        throw new RequestBodyError("request body is empty; expected a JSON object");
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        throw new RequestBodyError(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new RequestBodyError("request body must be a JSON object");
    }
    const body = parsed;
    const message = typeof body.message === "string" ? body.message : "";
    if (message.trim().length === 0) {
        throw new RequestBodyError("message is required and must be a non-empty string");
    }
    const files = [];
    const rawFiles = body.files ?? body.attachments;
    if (Array.isArray(rawFiles)) {
        for (const entry of rawFiles) {
            if (!entry || typeof entry !== "object") {
                continue;
            }
            const record = entry;
            const base64 = pickString(record.content) ??
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
async function parseMultipart(contentTypeLower, contentTypeRaw, raw) {
    if (!contentTypeLower.includes("boundary=")) {
        throw new RequestBodyError("multipart body is missing a boundary");
    }
    let form;
    try {
        form = await new Response(new Uint8Array(raw), {
            headers: { "content-type": contentTypeRaw },
        }).formData();
    }
    catch (err) {
        throw new RequestBodyError(`invalid multipart body: ${err instanceof Error ? err.message : String(err)}`);
    }
    const message = valueOf(form.get("message")) ?? "";
    if (message.trim().length === 0) {
        throw new RequestBodyError("message is required and must be a non-empty string");
    }
    const files = [];
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
function splitUrls(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return [];
    }
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.filter((v) => typeof v === "string" && v.trim().length > 0);
            }
        }
        catch {
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
function valueOf(value) {
    return typeof value === "string" ? value : undefined;
}
function shortField(value) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed.length > MAX_TEXT_FIELD_LENGTH
        ? trimmed.slice(0, MAX_TEXT_FIELD_LENGTH)
        : trimmed;
}
function pickString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
export function sendJson(res, status, payload) {
    if (res.writableEnded || res.destroyed) {
        return;
    }
    res.statusCode = status;
    if (!res.headersSent) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(payload));
}
export function sendError(res, status, message) {
    sendJson(res, status, {
        ok: false,
        error: { message, type: "invalid_request_error", code: status },
    });
}

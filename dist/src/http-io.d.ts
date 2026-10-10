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
export declare const MAX_REQUEST_BODY_BYTES: number;
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
export declare class RequestBodyError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode?: number);
}
export declare function readRawBody(req: IncomingMessage): Promise<Buffer>;
export declare function parseRequestBody(req: IncomingMessage, raw: Buffer): Promise<ParsedRequest>;
export declare function sendJson(res: ServerResponse, status: number, payload: unknown): void;
export declare function sendError(res: ServerResponse, status: number, message: string): void;

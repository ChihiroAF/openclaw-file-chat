/**
 * file-chat — OpenClaw HTTP chat endpoint with file transfer.
 *
 * Design notes (verified against OpenClaw v2026.9.4):
 *
 *  - Route registration uses `api.registerHttpRoute` (src/plugins/plugin-api.types.ts:222).
 *  - The agent is invoked through `agentCommandFromIngress` from
 *    `openclaw/plugin-sdk/agent-runtime`, the same ingress the existing
 *    custom-chat plugin uses. `AgentCommandIngressOpts` is `AgentCommandOpts`
 *    minus a small private allow/deny list, so `extraSystemPrompt`,
 *    `workspaceDir` and `cwd` are all reachable from a plugin.
 *  - Inbound files are written to disk by *this plugin* and referenced in the
 *    message text, mirroring what the native Gateway does
 *    (src/gateway/chat-attachments.ts:471 appends `\n[media attached: <ref>]`).
 *    The host's own attachment option only carries images
 *    (`AgentCommandOpts.images`, src/agents/command/types.ts:66), so doing it
 *    here keeps every MIME type working without depending on that path.
 *  - Outbound files are detected by diffing the session's outbound directory
 *    before and after the run. Local paths inside assistant text are NOT
 *    sanitised (sanitisation only targets structured media fields and
 *    registered `MEDIA:` URLs), so plain relative paths survive verbatim.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import { onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentEventPayload } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  OUTBOUND_DIR_PLACEHOLDER,
  OUTBOUND_REL_PLACEHOLDER,
  resolveFileChatConfig,
  type FileChatConfig,
} from "./src/config.js";
import {
  diffOutbound,
  resolveOutboundDir,
  saveInboundFiles,
  snapshotOutbound,
  type FileChatLogger,
  type InboundFile,
  type OutboundFile,
} from "./src/files.js";
import {
  parseRequestBody,
  readRawBody,
  RequestBodyError,
  sendError,
  sendJson,
} from "./src/http-io.js";
import { InvalidSessionKeyError, resolveSessionKey } from "./src/session.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

type FileChatAttachmentSummary = {
  name: string;
  path: string;
  absolutePath: string;
  size: number;
  mimeType?: string;
  source: "base64" | "url";
  sourceUrl?: string;
};

type FileChatOutboundSummary = {
  name: string;
  path: string;
  absolutePath: string;
  size: number;
  modifiedAt: string;
};

/** Prepared request context, built before the agent run starts. */
type PreparedTurn = {
  runId: string;
  sessionKey: string;
  sessionGenerated: boolean;
  inbound: InboundFile[];
  inboundFailures: Array<{ name: string; error: string }>;
  outboundSnapshot: ReturnType<typeof snapshotOutbound>;
  outboundAbsolute: string;
  message: string;
  systemPrompt: string;
};

async function handleFileChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: FileChatConfig,
  logger: FileChatLogger,
): Promise<boolean> {
  if (req.method !== "POST") {
    sendError(res, 405, "method not allowed; use POST");
    return true;
  }

  if (cfg.apiKey) {
    const provided = req.headers["x-api-key"];
    if (provided !== cfg.apiKey) {
      sendError(res, 401, "unauthorized");
      return true;
    }
  }

  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    if (err instanceof RequestBodyError) {
      sendError(res, err.statusCode, err.message);
      return true;
    }
    throw err;
  }

  let body: Awaited<ReturnType<typeof parseRequestBody>>;
  try {
    body = await parseRequestBody(req, raw);
  } catch (err) {
    if (err instanceof RequestBodyError) {
      sendError(res, err.statusCode, err.message);
      return true;
    }
    throw err;
  }

  let sessionKey: string;
  let sessionGenerated = false;
  try {
    const resolvedSession = resolveSessionKey({
      bodySessionKey: body.sessionKey,
      headerSessionKey: headerValue(req.headers["x-openclaw-session-key"]),
      user: body.user,
    });
    sessionKey = resolvedSession.sessionKey;
    sessionGenerated = resolvedSession.generated;
  } catch (err) {
    if (err instanceof InvalidSessionKeyError) {
      sendError(res, 400, err.message);
      return true;
    }
    throw err;
  }

  // Resolve the outbound directory first: it must exist before the snapshot,
  // and the model needs it to exist before it can write into it.
  const outboundDir = resolveOutboundDir(cfg, sessionKey);
  const outboundSnapshot = snapshotOutbound(cfg, sessionKey);

  const saved = await saveInboundFiles({
    cfg,
    sessionKey,
    inputs: body.files,
    logger,
  });

  const prepared: PreparedTurn = {
    runId: randomUUID(),
    sessionKey,
    sessionGenerated,
    inbound: saved.files,
    inboundFailures: saved.failures,
    outboundSnapshot,
    outboundAbsolute: outboundDir.absolute,
    message: buildAugmentedMessage(body.message, saved.files, saved.failures),
    systemPrompt: buildSystemPrompt(cfg, outboundDir.relative, outboundDir.absolute),
  };

  const isStreaming = body.stream !== false;
  const chatCompletionId = `chatcmpl_${prepared.runId}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const modelName = resolveModelLabel(body.provider, body.model, body.agentId, cfg);

  let nsReasoning = "";
  let nsContent = "";
  let runError: string | undefined;
  let finished = false;

  const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
    if (evt.runId !== prepared.runId || finished) {
      return;
    }
    switch (evt.stream) {
      case "thinking": {
        const delta = typeof evt.data.delta === "string" ? evt.data.delta : "";
        if (!delta) return;
        if (isStreaming) {
          writeChunk(res, {
            id: chatCompletionId,
            object: "chat.completion.chunk",
            created: createdAt,
            model: modelName,
            choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
          });
        } else {
          nsReasoning += delta;
        }
        break;
      }
      case "assistant": {
        const delta = typeof evt.data.delta === "string" ? evt.data.delta : "";
        if (!delta) return;
        if (isStreaming) {
          writeChunk(res, {
            id: chatCompletionId,
            object: "chat.completion.chunk",
            created: createdAt,
            model: modelName,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          });
        } else {
          nsContent += delta;
        }
        break;
      }
      case "lifecycle": {
        if (evt.data.phase === "error") {
          runError = typeof evt.data.message === "string" ? evt.data.message : "agent run failed";
        }
        break;
      }
      default:
        // tool / usage / item / compaction and other streams are not part of
        // the OpenAI chat completion shape; ignored on purpose.
        break;
    }
  });

  const finish = (params: {
    reason: "stop" | "error";
    message?: string;
    outbound: OutboundFile[];
    publicPathPrefix: string;
    appendFooter: boolean;
  }) => {
    if (finished) {
      return;
    }
    finished = true;

    const outboundSummary: FileChatOutboundSummary[] = params.outbound.map((file) => ({
      name: file.name,
      path: `${params.publicPathPrefix}${file.path}`,
      absolutePath: file.absolutePath,
      size: file.size,
      modifiedAt: file.modifiedAt,
    }));
    const attachments = prepared.inbound.map(toAttachmentSummary);

    const extras = {
      sessionKey: prepared.sessionKey,
      sessionGenerated: prepared.sessionGenerated,
      files: {
        inbound: attachments,
        outbound: outboundSummary,
      },
      ...(prepared.inboundFailures.length > 0
        ? { inboundFailures: prepared.inboundFailures }
        : {}),
    };

    try {
      if (isStreaming) {
        const footer = buildOutboundFooter(outboundSummary, params.appendFooter);
        if (footer) {
          writeChunk(res, {
            id: chatCompletionId,
            object: "chat.completion.chunk",
            created: createdAt,
            model: modelName,
            choices: [{ index: 0, delta: { content: footer }, finish_reason: null }],
          });
        }
        writeChunk(res, {
          id: chatCompletionId,
          object: "chat.completion.chunk",
          created: createdAt,
          model: modelName,
          choices: [{ index: 0, delta: {}, finish_reason: params.reason }],
          ...extras,
          ...(params.message ? { error: { message: params.message } } : {}),
        });
        if (!res.writableEnded && !res.destroyed) {
          res.write("data: [DONE]\n\n");
        }
      } else {
        const footer =
          params.reason === "stop"
            ? buildOutboundFooter(outboundSummary, params.appendFooter)
            : "";
        sendJson(res, 200, {
          id: chatCompletionId,
          object: "chat.completion",
          created: createdAt,
          model: modelName,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `${nsContent}${footer}`,
                ...(nsReasoning ? { reasoning_content: nsReasoning } : {}),
              },
              finish_reason: params.reason,
            },
          ],
          ...extras,
          ...(params.message ? { error: { message: params.message } } : {}),
        });
      }
    } finally {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
      unsubscribe();
    }
  };

  if (isStreaming) {
    res.writeHead(200, SSE_HEADERS);
    // OpenAI-compatible streams open with an empty role delta.
    writeChunk(res, {
      id: chatCompletionId,
      object: "chat.completion.chunk",
      created: createdAt,
      model: modelName,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  }

  try {
    await runAgentTurn({
      prepared,
      cfg,
      body: {
        agentId: body.agentId,
        thinking: body.thinking,
        provider: body.provider,
        model: body.model,
      },
      logger,
    });
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    logger.warn?.(`[file-chat] agent run failed: ${runError}`);
  }

  // Collect what the model produced. Done after the run resolves so the diff
  // reflects the completed turn.
  let outboundFiles: OutboundFile[] = [];
  try {
    outboundFiles = diffOutbound(cfg, prepared.sessionKey, prepared.outboundSnapshot);
  } catch (err) {
    logger.warn?.(
      `[file-chat] outbound scan failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (runError) {
    finish({
      reason: "error",
      message: runError,
      outbound: outboundFiles,
      publicPathPrefix: cfg.publicPathPrefix,
      appendFooter: false,
    });
  } else {
    finish({
      reason: "stop",
      outbound: outboundFiles,
      publicPathPrefix: cfg.publicPathPrefix,
      appendFooter: cfg.appendOutboundFooter,
    });
  }

  return true;
}

/**
 * Execute the agent turn.
 *
 * Two fallbacks mirror the behaviour of the sibling custom-chat plugin:
 *  - the requested thinking level may be unsupported by the model, so the
 *    level cascades down to `off`;
 *  - the per-run provider/model override may be rejected by the agent's model
 *    policy, in which case the run is retried without the override.
 */
async function runAgentTurn(params: {
  prepared: PreparedTurn;
  cfg: FileChatConfig;
  body: {
    agentId?: string;
    thinking?: string;
    provider?: string;
    model?: string;
  };
  logger: FileChatLogger;
}): Promise<void> {
  const { prepared, cfg, body } = params;

  const resolvedProvider = body.provider ?? cfg.defaultProvider;
  const resolvedModel = body.model ?? cfg.defaultModel;
  const hasOverride = resolvedProvider !== undefined || resolvedModel !== undefined;
  const requestedThinking = body.thinking ?? cfg.defaultThinking;

  const thinkingLevels = requestedThinking ? [requestedThinking, "low", "off"] : [undefined];
  const overridePhases = hasOverride ? [true, false] : [false];

  let lastError: unknown;
  outer: for (const useOverride of overridePhases) {
    for (const level of thinkingLevels) {
      try {
        await agentCommandFromIngress(
          {
            runId: prepared.runId,
            message: prepared.message,
            agentId: body.agentId,
            sessionKey: prepared.sessionKey,
            thinking: level,
            provider: useOverride ? resolvedProvider : undefined,
            model: useOverride ? resolvedModel : undefined,
            allowModelOverride: useOverride,
            deliver: false,
            extraSystemPrompt: prepared.systemPrompt,
          },
          undefined,
          undefined,
        );
        return;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (/not supported/i.test(message) && level !== "off") {
          // Pre-validation failure: no run started, safe to retry a lower level.
          params.logger.warn?.(
            `[file-chat] thinking level "${level}" unsupported, falling back`,
          );
          continue;
        }
        if (/not allowed/i.test(message) && useOverride) {
          params.logger.warn?.(
            "[file-chat] model override rejected by policy, retrying without override",
          );
          break;
        }
        throw err;
      }
    }
  }
  throw lastError ?? new Error("agent run failed");
}

function writeChunk(res: ServerResponse, chunk: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

/**
 * Build the model-visible message.
 *
 * Inbound files are referenced by absolute path so the model can read them
 * with ordinary file tools. This mirrors the native Gateway's
 * `[media attached: ...]` convention (src/gateway/chat-attachments.ts:471)
 * while remaining readable for non-image payloads.
 */
function buildAugmentedMessage(
  message: string,
  files: InboundFile[],
  failures: Array<{ name: string; error: string }>,
): string {
  if (files.length === 0 && failures.length === 0) {
    return message;
  }
  const lines: string[] = [message, "", "[file-chat inbound files]"];
  files.forEach((file, index) => {
    const mime = file.mimeType ? ` mime=${file.mimeType}` : "";
    lines.push(`${index + 1}. name=${file.name} path=${file.absolutePath} size=${file.size}${mime}`);
  });
  failures.forEach((failure) => {
    lines.push(`FAILED name=${failure.name} error=${failure.error}`);
  });
  return lines.join("\n");
}

function buildSystemPrompt(
  cfg: FileChatConfig,
  outboundRelative: string,
  outboundAbsolute: string,
): string | undefined {
  const instruction = cfg.outboundInstruction
    .replaceAll(OUTBOUND_DIR_PLACEHOLDER, outboundAbsolute)
    .replaceAll(OUTBOUND_REL_PLACEHOLDER, `${cfg.publicPathPrefix}${outboundRelative}`);
  return instruction.trim().length > 0 ? instruction : undefined;
}

function buildOutboundFooter(
  files: FileChatOutboundSummary[],
  enabled: boolean,
): string {
  if (!enabled || files.length === 0) {
    return "";
  }
  const lines = files.map((file) => `- ${file.path}`);
  return `\n\n[file-chat outbound files]\n${lines.join("\n")}`;
}

function toAttachmentSummary(file: InboundFile): FileChatAttachmentSummary {
  return {
    name: file.name,
    path: file.path,
    absolutePath: file.absolutePath,
    size: file.size,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    source: file.source,
    ...(file.sourceUrl ? { sourceUrl: file.sourceUrl } : {}),
  };
}

function resolveModelLabel(
  provider: string | undefined,
  model: string | undefined,
  agentId: string | undefined,
  cfg: FileChatConfig,
): string {
  const resolvedProvider = provider ?? cfg.defaultProvider;
  const resolvedModel = model ?? cfg.defaultModel;
  if (resolvedProvider && resolvedModel) {
    return `${resolvedProvider}/${resolvedModel}`;
  }
  if (resolvedModel) {
    return resolvedModel;
  }
  if (resolvedProvider) {
    return `${resolvedProvider}/${agentId ?? "default"}`;
  }
  return agentId ? `openclaw/${agentId}` : "openclaw/file-chat";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default definePluginEntry({
  id: "file-chat",
  name: "File Chat HTTP API",
  description:
    "HTTP chat endpoint with inbound file upload (base64 or URL) and outbound file delivery via local relative paths",
  register(api: OpenClawPluginApi) {
    const cfg = resolveFileChatConfig({ pluginConfig: api.pluginConfig });

    api.registerHttpRoute({
      path: cfg.path,
      auth: cfg.apiKey ? "plugin" : "gateway",
      match: "exact",
      handler: (req, res) => handleFileChat(req, res, cfg, api.logger),
    });

    api.logger.info?.(
      `[file-chat] route ${cfg.path} registered (filesRoot=${cfg.filesRoot}, auth=${cfg.apiKey ? "plugin" : "gateway"})`,
    );
  },
});

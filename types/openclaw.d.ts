/**
 * Ambient declarations for `openclaw/plugin-sdk/*` modules.
 *
 * The real types and implementations are provided by the OpenClaw host at
 * runtime through the `openclaw` peer dependency. These declarations let the
 * plugin compile standalone (outside the OpenClaw monorepo checkout) with
 * `tsc`, so it can be built into a distributable `dist/`.
 *
 * Declared surface is intentionally limited to what this plugin imports.
 * Verified against OpenClaw v2026.9.4:
 *   - plugin-entry / agent-runtime / agent-harness-runtime  (as used by custom-chat)
 *   - ssrf-runtime                                          (src/plugin-sdk/ssrf-runtime.ts)
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface OpenClawPluginLogger {
    info?(msg: string, ...args: unknown[]): void;
    warn?(msg: string, ...args: unknown[]): void;
    error?(msg: string, ...args: unknown[]): void;
    debug?(msg: string, ...args: unknown[]): void;
  }

  export interface OpenClawPluginHttpRouteParams {
    path: string;
    handler: (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => boolean | void | Promise<boolean | void>;
    /** `"gateway"` delegates auth to the Gateway; `"plugin"` means the plugin authenticates itself. */
    auth?: "gateway" | "plugin" | string;
    match?: "exact" | "prefix";
    handleUpgrade?: boolean;
    gatewayRuntimeScopeSurface?: string;
    nodeCapability?: string;
    replaceExisting?: boolean;
  }

  export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source?: string;
    rootDir?: string;
    readonly runtimeSource?: string;
    registrationMode?: string;
    /** Full resolved host config (e.g. `agents.defaults.workspace`). */
    config: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    runtime: Record<string, unknown>;
    logger: OpenClawPluginLogger;
    registerHttpRoute(params: OpenClawPluginHttpRouteParams): void;
    registerTool(tool: unknown, opts?: unknown): void;
    registerGatewayMethod(method: string, handler: unknown, opts?: unknown): void;
    registerReload(registration: unknown): void;
    registerService(service: unknown): void;
    on(hookName: string, handler: unknown, opts?: unknown): void;
    resolvePath(input: string): string;
  }

  export interface DefinedPluginEntry {
    id: string;
    name: string;
    description: string;
    configSchema?: unknown;
    register(api: OpenClawPluginApi): void;
  }

  export interface DefinePluginEntryOptions {
    id: string;
    name: string;
    description: string;
    configSchema?: unknown;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry(opts: DefinePluginEntryOptions): DefinedPluginEntry;
}

declare module "openclaw/plugin-sdk/agent-runtime" {
  /**
   * Restricted option surface for plugin/external ingress calls
   * (`AgentCommandIngressOpts`). Only the fields this plugin uses are declared.
   */
  export interface AgentCommandIngressOpts {
    message: string;
    /** Correlates agent events for this run. */
    runId?: string;
    /** User-visible transcript body; defaults to `message`. */
    transcriptMessage?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    thinking?: string;
    thinkingOnce?: string;
    provider?: string;
    model?: string;
    /** Must be explicitly set for ingress runs. */
    allowModelOverride: boolean;
    deliver?: boolean;
    /** Additional system prompt fragment merged into the run's system prompt. */
    extraSystemPrompt?: string;
    /** Explicit agent workspace override. */
    workspaceDir?: string;
    /** Explicit task working directory for this run. */
    cwd?: string;
    /** Per-run tool allow-list. */
    toolsAllow?: string[];
    abortSignal?: AbortSignal;
    timeout?: string;
    verbose?: string;
    lane?: string;
  }

  export function agentCommandFromIngress(
    opts: AgentCommandIngressOpts,
    runtime?: unknown,
    deps?: unknown,
  ): Promise<unknown>;
}

declare module "openclaw/plugin-sdk/agent-harness-runtime" {
  export type AgentEventStream =
    | "lifecycle"
    | "tool"
    | "assistant"
    | "usage"
    | "error"
    | "item"
    | "plan"
    | "approval"
    | "command_output"
    | "patch"
    | "compaction"
    | "thinking"
    | (string & {});

  export interface AgentEventPayload {
    runId: string;
    seq: number;
    stream: AgentEventStream;
    ts: number;
    data: Record<string, unknown>;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    lifecycleGeneration?: string;
  }

  export function onAgentEvent(listener: (evt: AgentEventPayload) => void): () => void;
}

declare module "openclaw/plugin-sdk/ssrf-runtime" {
  /** Subset of `GuardedFetchOptions` used by this plugin. */
  export interface GuardedFetchOptions {
    url: string;
    init?: RequestInit;
    timeoutMs?: number;
    signal?: AbortSignal;
    requireHttps?: boolean;
    maxRedirects?: number;
    auditContext?: string;
    policy?: Record<string, unknown>;
  }

  export interface GuardedFetchResult {
    response: Response;
    finalUrl: string;
    release: () => Promise<void>;
  }

  export function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult>;
  export function formatErrorMessage(error: unknown): string;
}

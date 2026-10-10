export type FileChatConfig = {
    /** HTTP route path. */
    path: string;
    /**
     * Absolute root directory holding both file trees.
     *
     * Layout:
     *   <filesRoot>/<inboundDirName>/<sessionId>/<file>
     *   <filesRoot>/<outboundDirName>/<sessionId>/<file>
     *
     * or, when `sessionScopedDirs` is false:
     *   <filesRoot>/<inboundDirName>/<file>
     *   <filesRoot>/<outboundDirName>/<file>
     */
    filesRoot: string;
    inboundDirName: string;
    outboundDirName: string;
    sessionScopedDirs: boolean;
    /** Prepended to relative paths when they are emitted to clients. */
    publicPathPrefix: string;
    maxFileBytes: number;
    maxFilesPerRequest: number;
    allowUrlFetch: boolean;
    appendOutboundFooter: boolean;
    /** Provider/model defaults applied when the request does not supply them. */
    defaultProvider?: string;
    defaultModel?: string;
    /** Thinking level applied when the request does not supply one. */
    defaultThinking?: string;
    /** System-prompt fragment describing the outbound directory contract. */
    outboundInstruction: string;
};
export declare const DEFAULT_PATH = "/api/v1/file-chat";
export declare const DEFAULT_MAX_FILE_BYTES: number;
export declare const DEFAULT_MAX_FILES_PER_REQUEST = 10;
/** Placeholder substituted with the absolute outbound directory. */
export declare const OUTBOUND_DIR_PLACEHOLDER = "{{outboundDir}}";
/** Placeholder substituted with the session-scoped relative outbound prefix. */
export declare const OUTBOUND_REL_PLACEHOLDER = "{{outboundRel}}";
export declare function defaultFilesRoot(): string;
export declare function resolveFileChatConfig({ pluginConfig, }: {
    pluginConfig?: Record<string, unknown>;
}): FileChatConfig;

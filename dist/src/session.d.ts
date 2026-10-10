export declare class InvalidSessionKeyError extends Error {
    constructor(message: string);
}
export declare function assertSessionKeyAllowed(sessionKey: string): string;
/**
 * Resolve the session key for a request.
 *
 * Priority: explicit `sessionKey` > `x-openclaw-session-key` header > `user`
 * (stable per user) > fresh random session.
 */
export declare function resolveSessionKey(params: {
    bodySessionKey?: string;
    headerSessionKey?: string;
    user?: string;
}): {
    sessionKey: string;
    generated: boolean;
};
/**
 * Turn a free-form identifier into a filesystem-safe, collision-resistant
 * directory segment. When sanitization changes the input we append a short
 * hash so two distinct session keys can never share one directory.
 */
export declare function sessionDirSegment(sessionKey: string): string;

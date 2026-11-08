/** Whether `quote` is a real excerpt of one of the user's recent messages. */
export function quotesUser(quote: any, texts: any): any;
/**
 * Decide whether this call may touch other sessions. Returns null when
 * allowed, or an error result explaining what the model must do instead.
 */
export function checkAccess({ args, current, config, index, session }: {
    args: any;
    current: any;
    config: any;
    index: any;
    session: any;
}): {
    ok: boolean;
    error: string;
} | null;
/** Map gateway arguments onto the recall engine's call shape. */
export function toEngineArgs(args: any, config: any): {
    query: any;
    scope: any;
    workspace: any;
    limit: any;
} | {
    query: any;
    detail: {
        sessionId: any;
    };
};
/**
 * Build the tool definition.
 * @param {object} deps
 * @param {any} deps.ctx
 * @param {() => object} deps.getConfig
 * @param {() => object} deps.servicesNow
 * @param {() => boolean} deps.isDisposed
 */
export function defineRecallTool({ ctx, getConfig, servicesNow, isDisposed }: {
    ctx: any;
    getConfig: () => object;
    servicesNow: () => object;
    isDisposed: () => boolean;
}): import("@deepseek-ai/dsh-tools").ToolDefinition;

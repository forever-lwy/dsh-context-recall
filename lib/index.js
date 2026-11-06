import { registerSettings } from './settings.js';
import { OnlineEmbedder, vectorFingerprint } from './embedding.js';
import { applyRecall } from './recall.js';
import { registerCompressionBridge } from './compaction.js';
export const name = 'dsh-context-recall';
export const inject = ['tools', 'sessions', 'sessionQuery', 'sessionPersistence', 'agents', 'systemPrompt', 'llm', 'credentials', 'typert'];
export async function apply(ctx) {
    const settings = await registerSettings(ctx);
    // Web's real backends belong to isolated preset scopes. Bind each native
    // instance through the registry; leave their declarations and policies intact.
    ctx.inject(['agentPresets'], scoped => {
        registerCompressionBridge(scoped, () => settings.current(), {
            registerThresholdValidator: validate => settings.addThresholdValidator(validate),
        });
    });
    let embedder = null;
    let connectionIdentity = '';
    ctx.effect(() => async () => { await embedder?.dispose(); embedder = null; });
    const getEmbedder = () => {
        const config = settings.current().embedding;
        if (!config.enabled)
            return null;
        const identity = JSON.stringify(config);
        if (connectionIdentity !== identity || embedder?.fingerprint !== vectorFingerprint(config)) {
            void embedder?.dispose();
            embedder = new OnlineEmbedder(config, () => settings.resolveKey(config.apiKeyRef));
            connectionIdentity = identity;
        }
        return embedder;
    };
    applyRecall(ctx, () => {
        const config = settings.current();
        return { ...config.recall, semantic: config.embedding.enabled && config.recall.semantic, background: config.embedding.background };
    }, getEmbedder);
}

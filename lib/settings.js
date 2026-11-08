var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConfigStore, ConfigConflict } from './store.js';
import { OnlineEmbedder } from './embedding.js';
import { remoteInfo, saveSchema, testSchema, searchRequestSchema, readRequestSchema, locateRequestSchema } from './remote.js';
let ContextRecallService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _search_decorators;
    let _read_decorators;
    let _locate_decorators;
    let _status_decorators;
    let _get_decorators;
    let _save_decorators;
    let _test_decorators;
    return class ContextRecallService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _search_decorators = [Remote];
            _read_decorators = [Remote];
            _locate_decorators = [Remote];
            _status_decorators = [Remote];
            _get_decorators = [Remote];
            _save_decorators = [Remote];
            _test_decorators = [Remote];
            __esDecorate(this, null, _search_decorators, { kind: "method", name: "search", static: false, private: false, access: { has: obj => "search" in obj, get: obj => obj.search }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _read_decorators, { kind: "method", name: "read", static: false, private: false, access: { has: obj => "read" in obj, get: obj => obj.read }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _locate_decorators, { kind: "method", name: "locate", static: false, private: false, access: { has: obj => "locate" in obj, get: obj => obj.locate }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _status_decorators, { kind: "method", name: "status", static: false, private: false, access: { has: obj => "status" in obj, get: obj => obj.status }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _get_decorators, { kind: "method", name: "get", static: false, private: false, access: { has: obj => "get" in obj, get: obj => obj.get }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _save_decorators, { kind: "method", name: "save", static: false, private: false, access: { has: obj => "save" in obj, get: obj => obj.save }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _test_decorators, { kind: "method", name: "test", static: false, private: false, access: { has: obj => "test" in obj, get: obj => obj.test }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        store = __runInitializers(this, _instanceExtraInitializers);
        saves = Promise.resolve();
        thresholdValidators = new Set();
        savedListeners = new Set();
        searchApi = null;
        /** Attach the search page API; returns the detacher. */
        attachSearch(api) {
            this.searchApi = api;
            return () => { if (this.searchApi === api)
                this.searchApi = null; };
        }
        requireSearch() {
            if (!this.searchApi)
                throw new RemoteError('gateway/internal', '会话索引尚未就绪，请稍后重试。', {});
            return this.searchApi;
        }
        async search(request, signal) {
            const parsed = searchRequestSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '检索参数无效。', {});
            signal.throwIfAborted();
            try {
                return await this.requireSearch().search(parsed.data, signal);
            }
            catch (error) {
                if (error instanceof RemoteError || signal.aborted)
                    throw error;
                throw new RemoteError('gateway/internal', error instanceof Error ? error.message : '检索失败。', {});
            }
        }
        async read(request, signal) {
            const parsed = readRequestSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '读取参数无效。', {});
            signal.throwIfAborted();
            return this.requireSearch().read(parsed.data);
        }
        async locate(request, signal) {
            const parsed = locateRequestSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '定位参数无效。', {});
            signal.throwIfAborted();
            try {
                return await this.requireSearch().locate(parsed.data);
            }
            catch (error) {
                if (error instanceof RemoteError)
                    throw error;
                return { ok: false, error: error instanceof Error ? error.message : '定位失败。' };
            }
        }
        async status(request, signal) {
            signal.throwIfAborted();
            if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length) {
                throw new RemoteError('gateway/bad-request', '状态读取参数无效。', {});
            }
            return this.requireSearch().status();
        }
        /** Observe successful saves; returns the disposer. */
        onSaved(listener) {
            this.savedListeners.add(listener);
            return () => { this.savedListeners.delete(listener); };
        }
        constructor(ctx, store) {
            super(ctx, 'contextRecall');
            this.store = store;
        }
        current() { return this.store.current(); }
        addThresholdValidator(validate) {
            this.thresholdValidators.add(validate);
            return () => { this.thresholdValidators.delete(validate); };
        }
        async resolveKey(ref) {
            return (await this.ctx.credentials.resolve(credentialRef(ref)))?.value;
        }
        async get(request, signal) {
            signal.throwIfAborted();
            if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length) {
                throw new RemoteError('gateway/bad-request', '配置读取参数无效。', {});
            }
            const config = this.current();
            const info = await this.ctx.credentials.describe(credentialRef(config.embedding.apiKeyRef));
            const models = [];
            const llm = this.ctx.llm;
            for (const { id: provider } of llm.listProviders()) {
                try {
                    for (const model of await llm.listModels(provider))
                        models.push({ provider, model: model.id, name: model.name ?? model.id });
                }
                catch { /* One unavailable provider must not hide the rest of the GUI. */ }
            }
            signal.throwIfAborted();
            return { config, revision: this.store.revision(), credential: { configured: info.configured, writable: info.writable }, models,
                status: { semanticAvailable: config.embedding.enabled && config.recall.semantic,
                    message: config.embedding.enabled ? '在线向量已启用；待索引的对话文本将发送至配置的向量服务。' : '在线向量尚未启用，当前使用本地模糊检索及全文检索。' } };
        }
        async save(request, signal) {
            const parsed = saveSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '配置输入无效，请检查压缩模型、URL 和数值范围。', {});
            const task = this.saves.then(() => this.saveExclusive(parsed.data, signal));
            this.saves = task.catch(() => { });
            return task;
        }
        async saveExclusive(request, signal) {
            signal.throwIfAborted();
            if (request.apiKey && request.clearApiKey)
                throw new RemoteError('gateway/bad-request', '不能同时清除和填写 API Key。', {});
            await this.store.load();
            if (request.expectedRevision !== this.store.revision())
                throw new RemoteError('gateway/bad-request', '配置已在其他窗口修改，请重新加载后保存。', {});
            try {
                for (const validate of this.thresholdValidators)
                    validate(request.config.compression.thresholdRatio);
            }
            catch (error) {
                throw new RemoteError('gateway/bad-request', error instanceof Error ? error.message : '压缩触发比例与原生保留策略冲突。', {});
            }
            if (request.config.compression.provider) {
                try {
                    await this.ctx.llm.resolveModelInfo(request.config.compression.provider, request.config.compression.model, signal);
                }
                catch {
                    throw new RemoteError('gateway/bad-request', '压缩模型不可用，请先在 dsh 模型设置中配置该提供方与模型。', {});
                }
            }
            const ref = credentialRef(request.config.embedding.apiKeyRef);
            if (request.apiKey !== undefined || request.clearApiKey) {
                if (!(await this.ctx.credentials.describe(ref)).writable)
                    throw new RemoteError('gateway/bad-request', '当前凭据来源不可写，请更换凭据引用。', {});
                if (request.apiKey && /[\r\n\u0000]/.test(request.apiKey))
                    throw new RemoteError('gateway/bad-request', 'API Key 含无效字符。', {});
            }
            signal.throwIfAborted();
            // Publish config last, so a failed secret write cannot activate a half-saved connection.
            try {
                if (request.apiKey !== undefined)
                    await this.ctx.credentials.set(ref, request.apiKey);
                else if (request.clearApiKey)
                    await this.ctx.credentials.unset(ref);
                await this.store.save(request.config, request.expectedRevision);
            }
            catch (error) {
                if (error instanceof ConfigConflict)
                    throw new RemoteError('gateway/bad-request', error.message, {});
                throw new RemoteError('gateway/internal', '保存失败，请重新加载核对配置和凭据后重试。', {});
            }
            for (const listener of this.savedListeners) {
                try {
                    listener();
                }
                catch { /* listeners never fail a save */ }
            }
            return this.get({}, new AbortController().signal);
        }
        async test(request, signal) {
            const parsed = testSchema.safeParse(request);
            if (!parsed.success)
                throw new RemoteError('gateway/bad-request', '向量测试参数无效。', {});
            const embedder = new OnlineEmbedder({ ...parsed.data.config.embedding, enabled: true }, async () => parsed.data.apiKey ?? this.resolveKey(parsed.data.config.embedding.apiKeyRef));
            const cancel = () => { void embedder.dispose(); };
            signal.addEventListener('abort', cancel, { once: true });
            try {
                signal.throwIfAborted();
                const vector = await embedder.embed('connection test');
                return { dimensions: vector.length, message: `连接成功，向量维度 ${vector.length}。测试未发送会话历史。` };
            }
            catch (error) {
                throw new RemoteError('gateway/bad-request', error instanceof Error && error.name === 'EmbeddingError' ? error.message : '向量连接测试已取消或失败。', {});
            }
            finally {
                signal.removeEventListener('abort', cancel);
                await embedder.dispose();
            }
        }
    };
})();
export { ContextRecallService };
export async function registerSettings(ctx) {
    const store = new ConfigStore(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'context-recall-settings.json'));
    await store.load();
    const service = new ContextRecallService(ctx, store);
    ctx.typert.remotes.register(remoteInfo);
    return service;
}

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { remoteInfo, readSettings, saveSettings, testEmbedding, searchSessions, readSessionText, readIndexStatus, locateMessage } from '../remote.js';
import { ContextRecallSettings } from './Settings.js';
import { SearchPage, SearchIcon } from './SearchPage.js';
import { openSession } from './navigate.js';
/** Panel id of the session search page (sidebar row id = main page key). */
export const SEARCH_PANEL_ID = 'context-recall-search';
import { zh, en } from './locales.js';
import { styles } from './styles.js';
export const name = 'dsh-context-recall-client';
export const inject = ['slots', 'locale', 'remote'];
const namespace = 'contextRecall';
export function RecallToolView({ block, t }) {
    const translate = t ?? ((key) => zh[key] ?? key);
    const settled = block?.kind === 'tool-result';
    const failed = settled && (block.isError || block.result?.ok === false);
    return _jsxs("div", { className: `dcr-recall ${settled ? failed ? 'failed' : 'done' : 'running'}`, role: "status", children: [_jsx("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: _jsx("path", { d: "M8 2a5 5 0 1 0 4.9 6.5M8 5v3l2 1.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }) }), _jsx("span", { children: translate(settled ? failed ? 'recallFailed' : 'done' : 'recalling') })] });
}
export async function apply(ctx) {
    const unmount = await ctx.remote.$mount(remoteInfo);
    ctx.effect(() => unmount, 'context-recall: remote schema');
    ctx.effect(() => ctx.locale.register(namespace, 'zh', zh), 'context-recall: Chinese');
    ctx.effect(() => ctx.locale.register(namespace, 'en', en), 'context-recall: English');
    ctx.effect(() => {
        const node = document.createElement('style');
        node.dataset.plugin = 'dsh-context-recall';
        node.textContent = styles;
        document.head.appendChild(node);
        return () => node.remove();
    }, 'context-recall: styles');
    const t = ctx.locale.bind(namespace);
    ctx.inject(['remote.contextRecall'], (remoteCtx) => {
        const face = {
            read: signal => readSettings(remoteCtx.remote, signal),
            save: (request, signal) => saveSettings(remoteCtx.remote, request, signal),
            test: (request, signal) => testEmbedding(remoteCtx.remote, request, signal),
        };
        remoteCtx.slots.inject('settings.section', () => remoteCtx.slots.register({
            name: 'settings.section', id: 'context-recall', order: 35, label: () => t('nav'),
            inject: () => ({ ...face, t }),
        }, ContextRecallSettings));
        const search = {
            search: (request, signal) => searchSessions(remoteCtx.remote, request, signal),
            read: (request, signal) => readSessionText(remoteCtx.remote, request, signal),
            status: signal => readIndexStatus(remoteCtx.remote, signal),
            open: (sessionId, seq) => openSession(ctx, sessionId, seq === undefined ? undefined : async () => {
                const found = await locateMessage(remoteCtx.remote, { sessionId, seq });
                return found.ok && found.turn !== undefined ? { turn: found.turn, text: found.text } : null;
            }),
            t,
        };
        // Session search: a sidebar tool row that opens a full main-column page.
        // Seats declared by the layout and sidebar client packages (typed there).
        const slots = remoteCtx.slots;
        slots.inject('main', () => slots.register({
            name: 'main', key: SEARCH_PANEL_ID, locale: namespace, inject: () => search,
        }, SearchPage));
        slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist', id: SEARCH_PANEL_ID, order: 7, locale: namespace, label: () => t('searchTitle'),
        }, SearchIcon));
    });
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview', key: 'recall', locale: namespace, inject: () => ({ t }),
    }, RecallToolView));
}
export { ContextRecallSettings } from './Settings.js';

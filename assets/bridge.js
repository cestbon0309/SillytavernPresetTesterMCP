/*
 * stpd page bridge. Injected into the SillyTavern page before any SillyTavern script runs.
 *
 * - Wraps window.fetch to observe (and, for batch generation, fan out) chat-completion requests.
 * - Mirrors toasts to the console so the daemon can report them.
 * - Auto-confirms SillyTavern popups while an stpd operation is running.
 * - Exposes window.__stpd.ops.* which the daemon calls through page.evaluate().
 */
(() => {
    if (window.__stpd) return;

    const GEN_URL = '/api/backends/chat-completions/generate';
    const origFetch = window.fetch.bind(window);

    const stpd = {
        ready: false,
        /** number of completed /api/presets/save calls (import completion signal) */
        presetSaves: 0,
        /** OAI_PRESET_CHANGED_AFTER counter */
        presetChanges: 0,
        /** popup auto-handling: null | 'ok' | 'cancel'. 'ok' until the app is ready (first-run onboarding). */
        autoPopup: 'ok',
        gen: {
            /** every chat-completion request seen (most recent last, capped) */
            captures: [],
            /** batch fan-out state, set by ops.generate */
            fanout: null,
        },
        ops: {},
    };
    window.__stpd = stpd;

    // ------------------------------------------------------------------ fetch interception

    function urlOf(input) {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.href;
        return input?.url ?? '';
    }

    /**
     * Batch requests go through the daemon (Node side, same cookies) when available: Chrome allows only
     * 6 concurrent HTTP/1.1 connections per host, which would serialise batches larger than 6.
     */
    async function nodeFetch(url, init) {
        const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : (init.headers || {});
        const r = await window.__stpdNodeFetch(new URL(url, location.href).href, {
            method: init.method || 'POST',
            headers,
            body: typeof init.body === 'string' ? init.body : undefined,
        });
        if (r.error) throw new TypeError(r.error);
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            statusText: r.statusText,
            headers: new Headers(r.headers),
            text: async () => r.text,
        };
    }

    async function doRequest(url, init, { viaNode = false } = {}) {
        const started = performance.now();
        const item = { body: init.body, status: 0, ok: false, text: '', json: null, error: null, ms: 0 };
        try {
            const res = viaNode && typeof window.__stpdNodeFetch === 'function'
                ? await nodeFetch(url, init)
                : await origFetch(url, init);
            item.status = res.status;
            item.statusText = res.statusText;
            item.headers = [...res.headers.entries()];
            item.text = await res.text();
            try { item.json = JSON.parse(item.text); } catch { /* stream or non-JSON */ }
            item.ok = res.ok && !(item.json && item.json.error);
            if (!item.ok) {
                item.error = item.json?.error?.message || item.json?.error || `HTTP ${res.status} ${res.statusText}`;
                if (typeof item.error !== 'string') item.error = JSON.stringify(item.error);
            }
        } catch (e) {
            item.error = String(e?.message || e);
            item.networkError = e;
        }
        item.ms = Math.round(performance.now() - started);
        return item;
    }

    function toResponse(item) {
        if (item.networkError) throw item.networkError;
        return new Response(item.text, {
            status: item.status,
            statusText: item.statusText || '',
            headers: item.headers || [['content-type', 'application/json']],
        });
    }

    function remember(item) {
        stpd.gen.captures.push(item);
        if (stpd.gen.captures.length > 50) stpd.gen.captures.shift();
    }

    window.fetch = async function (input, init) {
        const url = urlOf(input);
        if (url.includes('/api/presets/save')) {
            const res = await origFetch(input, init);
            stpd.presetSaves++;
            return res;
        }
        if (!(url.includes(GEN_URL) && init && String(init.method).toUpperCase() === 'POST')) {
            return origFetch(input, init);
        }

        const fan = stpd.gen.fanout;
        if (fan && fan.started) {
            // Subsequent swipe generations of a batch: serve the pre-fetched replies in order.
            const next = fan.queue.shift();
            if (!next) {
                return toResponse({ status: 500, text: JSON.stringify({ error: { message: 'stpd: no more batch replies' } }) });
            }
            fan.served.push(next);
            return toResponse(next);
        }

        if (fan && !fan.started) {
            fan.started = true;
            // Fire N byte-identical requests at once (no abort signal on the extra ones so a
            // stopped swipe animation can't cancel siblings).
            const promises = [];
            for (let i = 0; i < fan.n; i++) {
                const reqInit = { ...init };
                if (i > 0) delete reqInit.signal;
                promises.push(doRequest(url, reqInit, { viaNode: fan.n > 1 }).then(item => { item.index = i; remember(item); return item; }));
            }
            fan.all = promises;
            // Serve the first successful reply in index order; queue the remaining successful ones.
            const settled = [];
            let chosen = null;
            for (const p of promises) {
                const item = await p;
                settled.push(item);
                if (item.ok) { chosen = item; break; }
            }
            const rest = await Promise.all(promises);
            fan.results = rest;
            fan.queue = rest.filter(it => it.ok && it !== chosen);
            const first = chosen || rest[0];
            fan.served.push(first);
            return toResponse(first);
        }

        const item = await doRequest(url, init);
        remember(item);
        return toResponse(item);
    };

    // ------------------------------------------------------------------ toasts & popups

    function hookToastr() {
        const t = window.toastr;
        if (!t || t.__stpdHooked) return !!t;
        for (const level of ['error', 'warning', 'info', 'success']) {
            const orig = t[level].bind(t);
            t[level] = function (message, title, ...rest) {
                const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                console.info(`[stpd-toast:${level}] ${strip(title) ? strip(title) + ': ' : ''}${strip(message)}`);
                return orig(message, title, ...rest);
            };
        }
        t.__stpdHooked = true;
        return true;
    }
    const toastTimer = setInterval(() => { if (hookToastr()) clearInterval(toastTimer); }, 50);

    /** Popups where the safe automatic answer is not the OK button. */
    const POPUP_RULES = [
        // Preset import: keep custom-endpoint body/header tweaks ("Import as-is"); connection fields are unbound anyway.
        { match: /contains proxy and\/or custom endpoint settings/i, action: 'cancel' },
    ];

    setInterval(() => {
        if (!stpd.autoPopup) return;
        const dialogs = [...document.querySelectorAll('dialog.popup[open]')];
        for (const dlg of dialogs) {
            if (dlg.dataset.stpdHandled) continue;
            const text = (dlg.querySelector('.popup-content') || dlg).innerText?.trim() || '';
            // Text-specific rules first, then the default action.
            let action = typeof stpd.autoPopup === 'string' ? stpd.autoPopup : 'ok';
            for (const rule of POPUP_RULES) {
                if (rule.match.test(text)) { action = rule.action; break; }
            }
            const sel = action === 'cancel' ? '.popup-button-cancel' : '.popup-button-ok';
            const btn = dlg.querySelector(sel) || dlg.querySelector('.popup-button-ok');
            if (btn && btn.offsetParent !== null) {
                dlg.dataset.stpdHandled = '1';
                console.info(`[stpd-popup] auto-${action}: ${text.slice(0, 300)}`);
                btn.click();
            }
        }
    }, 150);

    // ------------------------------------------------------------------ helpers

    const ctx = () => window.SillyTavern.getContext();
    const st = (path) => import(path);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function waitFor(cond, timeout = 15000, label = 'condition') {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            try { if (await cond()) return; } catch { /* retry */ }
            await sleep(50);
        }
        throw new Error(`Timed out waiting for ${label}`);
    }

    function fail(msg) {
        const e = new Error(msg);
        e.stpdUser = true;
        throw e;
    }

    function findCharacterIndex(name) {
        const chars = ctx().characters;
        const norm = String(name).trim().toLowerCase();
        let idx = chars.findIndex(c => c.avatar?.toLowerCase() === norm);
        if (idx < 0) idx = chars.findIndex(c => c.name?.toLowerCase() === norm);
        if (idx < 0) idx = chars.findIndex(c => c.avatar?.toLowerCase() === norm + '.png');
        if (idx < 0) fail(`Character not found: ${name}. Available: ${chars.map(c => c.name).join(', ') || '(none)'}`);
        return idx;
    }

    async function selectCharacter(name) {
        const idx = findCharacterIndex(name);
        const c = ctx();
        if (String(c.characterId) !== String(idx) || c.groupId) {
            await c.selectCharacterById(idx, { switchMenu: false });
            await waitFor(() => String(ctx().characterId) === String(idx), 15000, 'character selection');
        }
        await waitFor(() => !document.querySelector('#chat .mes') || ctx().chat.length > 0 || true, 5000, 'chat load');
        return idx;
    }

    async function openChat(chatName) {
        const c = ctx();
        const current = c.getCurrentChatId();
        if (current === chatName) return;
        const idx = c.characterId;
        const list = await fetchChatList(c.characters[idx].avatar);
        if (!list.some(x => x.file_name.replace(/\.jsonl$/, '') === chatName)) {
            fail(`Chat not found: ${chatName}. Available: ${list.map(x => x.file_name.replace(/\.jsonl$/, '')).join(', ')}`);
        }
        await c.openCharacterChat(chatName);
        await waitFor(() => ctx().getCurrentChatId() === chatName, 15000, 'chat open');
    }

    async function fetchChatList(avatar) {
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: false }),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : Object.values(data);
    }

    async function newChat() {
        const before = ctx().getCurrentChatId();
        const script = await st('/script.js');
        await script.doNewChat({ deleteCurrentChat: false });
        await waitFor(() => ctx().getCurrentChatId() !== before, 15000, 'new chat');
    }

    function toStMessage(m) {
        const c = ctx();
        const now = new Date().toISOString();
        if (m.role === 'user') {
            return { name: m.name || c.name1, is_user: true, is_system: false, send_date: now, mes: m.content, extra: {} };
        }
        if (m.role === 'system') {
            return { name: m.name || 'System', is_user: false, is_system: false, send_date: now, mes: m.content, extra: { type: 'narrator' } };
        }
        return {
            name: m.name || c.name2, is_user: false, is_system: false, send_date: now, mes: m.content,
            swipes: [m.content], swipe_id: 0, swipe_info: [{ send_date: now, extra: {} }], extra: {},
        };
    }

    /** Replace the whole current chat with the given messages (either {role, content} or raw ST messages). */
    async function setHistory(history, { save = true } = {}) {
        const c = ctx();
        const msgs = history.map(m => (m && 'mes' in m) ? structuredClone(m) : toStMessage(m));
        c.chat.splice(0, c.chat.length, ...msgs);
        if (save) {
            await c.saveChat();
            await c.reloadCurrentChat();
            await waitFor(() => ctx().chat.length === msgs.length, 15000, 'chat reload');
        }
    }

    /** Character + chat selection shared by most ops. */
    async function prepareChat({ character, chat, new_chat, history }) {
        if (character) await selectCharacter(character);
        else if (ctx().characterId === undefined) fail('No character selected; pass "character".');
        if (chat) await openChat(chat);
        if (new_chat || (history && !chat)) await newChat();
        if (history) await setHistory(history);
    }

    function setTextarea(text) {
        const ta = document.getElementById('send_textarea');
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function summarizeMessage(m, i) {
        const out = {
            index: i,
            role: m.is_user ? 'user' : (m.extra?.type === 'narrator' || m.is_system ? 'system' : 'assistant'),
            name: m.name,
            text: m.mes,
        };
        if (m.is_system) out.hidden = true;
        if (Array.isArray(m.swipes) && m.swipes.length > 1) {
            out.swipe_id = m.swipe_id ?? 0;
            out.swipes = m.swipes.map((s, j) => ({ swipe_id: j, text: s, reasoning: m.swipe_info?.[j]?.extra?.reasoning || undefined }));
        }
        if (m.extra?.reasoning) out.reasoning = m.extra.reasoning;
        return out;
    }

    function finishReason(json) {
        if (!json) return undefined;
        return json.choices?.[0]?.finish_reason ?? json.stop_reason ?? json.candidates?.[0]?.finishReason ?? undefined;
    }

    // ------------------------------------------------------------------ ops

    const ops = stpd.ops;

    /** One-time setup after each page load. */
    ops.init = async () => {
        const c = ctx();
        // Presets must not switch provider/model/URL: connection is owned by set_endpoint / set_model.
        if (c.chatCompletionSettings.bind_preset_to_connection) {
            $('#bind_preset_to_connection').prop('checked', false).trigger('input');
            c.chatCompletionSettings.bind_preset_to_connection = false;
            c.saveSettingsDebounced();
        }
        // Reconnect to the configured Chat Completion endpoint after a (re)load.
        if (c.mainApi === 'openai' && (!c.onlineStatus || c.onlineStatus === 'no_connection')) {
            $('#api_button_openai').trigger('click');
            await waitFor(() => ctx().onlineStatus && ctx().onlineStatus !== 'no_connection', 15000, 'connection').catch(() => {});
        }
        return { online_status: ctx().onlineStatus };
    };

    ops.status = async () => {
        const c = ctx();
        const oai = c.chatCompletionSettings;
        const ch = c.characters[c.characterId];
        let model = '';
        try { model = (await st('/scripts/openai.js')).getChatCompletionModel(oai); } catch { /* ignore */ }
        return {
            main_api: c.mainApi,
            provider: oai.chat_completion_source,
            custom_url: oai.chat_completion_source === 'custom' ? oai.custom_url : undefined,
            online_status: c.onlineStatus,
            model,
            preset: oai.preset_settings_openai,
            character: ch ? { name: ch.name, avatar: ch.avatar } : null,
            chat: c.getCurrentChatId() || null,
            chat_length: c.chat.length,
            user_name: c.name1,
        };
    };

    ops.listProviders = async () => {
        const c = ctx();
        const fromMap = Object.entries(c.CONNECT_API_MAP || {})
            .filter(([, v]) => v.selected === 'openai' && v.source)
            .map(([k, v]) => ({ id: v.source, alias: k }));
        const fromSelect = [...document.querySelectorAll('#chat_completion_source option')]
            .map(o => ({ id: o.value, label: o.textContent.trim() }));
        const merged = new Map();
        for (const s of fromSelect) merged.set(s.id, { id: s.id, label: s.label, aliases: [] });
        for (const a of fromMap) {
            if (!merged.has(a.id)) merged.set(a.id, { id: a.id, label: a.id, aliases: [] });
            if (a.alias !== a.id) merged.get(a.id).aliases.push(a.alias);
        }
        return [...merged.values()];
    };

    ops.setEndpoint = async ({ provider, url, api_key }) => {
        const c = ctx();
        const providers = await ops.listProviders();
        const p = providers.find(x => x.id === provider || x.aliases.includes(provider));
        if (!p) fail(`Unknown provider "${provider}". Known: ${providers.map(x => x.id).join(', ')}`);

        // Switch main API to Chat Completion and select source (same as the UI dropdowns).
        if (c.mainApi !== 'openai') {
            $('#main_api').val('openai').trigger('change');
        }
        if (c.chatCompletionSettings.chat_completion_source !== p.id) {
            $('#chat_completion_source').val(p.id).trigger('change');
        }
        await waitFor(() => ctx().chatCompletionSettings.chat_completion_source === p.id, 5000, 'source change');

        if (url) {
            if (p.id === 'custom') {
                $('#custom_api_url_text').val(url).trigger('input');
            } else {
                const r = await c.executeSlashCommandsWithOptions(`/api-url api=${p.id} connect=false quiet=true ${JSON.stringify(url)}`);
                if (r?.isError) fail(`Failed to set URL for ${p.id}: ${r.errorMessage}`);
            }
        }

        if (api_key) {
            const secrets = await st('/scripts/secrets.js');
            const key = secrets.resolveSecretKey ? secrets.resolveSecretKey() : null;
            if (!key) fail(`Could not resolve the secret key for provider ${p.id}.`);
            await secrets.writeSecret(key, api_key, 'stpd');
        }

        c.saveSettingsDebounced();
        // Connect (status check).
        $('#api_button_openai').trigger('click');
        try {
            await waitFor(() => {
                const s = ctx().onlineStatus;
                return s && s !== 'no_connection';
            }, 30000, 'connection');
        } catch { /* fall through: report status */ }
        return ops.status();
    };

    function modelSelectId(source) {
        // Per-source model <select>/<input>, discovered from the DOM rather than hard-coded.
        const map = {
            openai: '#model_openai_select', claude: '#model_claude_select', openrouter: '#model_openrouter_select',
            makersuite: '#model_google_select', vertexai: '#model_vertexai_select', mistralai: '#model_mistralai_select',
            custom: '#custom_model_id', cohere: '#model_cohere_select', perplexity: '#model_perplexity_select',
            groq: '#model_groq_select', deepseek: '#model_deepseek_select', xai: '#model_xai_select',
            ai21: '#model_ai21_select', nanogpt: '#model_nanogpt_select', aimlapi: '#model_aimlapi_select',
            pollinations: '#model_pollinations_select', moonshot: '#model_moonshot_select', fireworks: '#model_fireworks_select',
            cometapi: '#model_cometapi_select', azure_openai: '#azure_openai_model', electronhub: '#model_electronhub_select',
            siliconflow: '#model_siliconflow_select', zai: '#model_zai_select', minimax: '#model_minimax_select',
        };
        return map[source];
    }

    ops.listModels = async () => {
        const source = ctx().chatCompletionSettings.chat_completion_source;
        const sel = modelSelectId(source);
        const el = sel && document.querySelector(sel);
        let models = [];
        if (el && el.tagName === 'SELECT') {
            models = [...el.querySelectorAll('option')].map(o => o.value).filter(Boolean);
        }
        if (source === 'custom') {
            models = [...document.querySelectorAll('#model_custom_select option')].map(o => o.value).filter(Boolean);
        }
        return { provider: source, models: [...new Set(models)] };
    };

    ops.setModel = async ({ model }) => {
        const c = ctx();
        const r = await c.executeSlashCommandsWithOptions(`/model quiet=true ${JSON.stringify(model)}`);
        if (r?.isError) fail(`Failed to set model: ${r.errorMessage}`);
        const oai = await st('/scripts/openai.js');
        const now = oai.getChatCompletionModel(c.chatCompletionSettings);
        if (now !== model) {
            // Fall back to setting the per-source field directly (e.g. models not listed by the provider).
            const source = c.chatCompletionSettings.chat_completion_source;
            const sel = modelSelectId(source);
            const el = sel && document.querySelector(sel);
            if (el) {
                if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === model)) {
                    el.append(new Option(model, model));
                }
                $(el).val(model).trigger('change').trigger('input');
            }
        }
        c.saveSettingsDebounced();
        return { provider: c.chatCompletionSettings.chat_completion_source, model: oai.getChatCompletionModel(c.chatCompletionSettings) };
    };

    ops.listPresets = async () => {
        const pm = ctx().getPresetManager('openai');
        const names = pm.getAllPresets ? pm.getAllPresets() : [...document.querySelectorAll('#settings_preset_openai option')].map(o => o.textContent.trim());
        return { selected: pm.getSelectedPresetName(), presets: names };
    };

    /** Snapshot counters before triggering a UI import. */
    ops.armPresetImport = async () => ({ saves: stpd.presetSaves, changes: stpd.presetChanges });

    /** Import a preset via the real UI file input so all import hooks (e.g. embedded regex) run. */
    ops.presetImported = async ({ name, armed }) => {
        await waitFor(() => stpd.presetSaves > armed.saves, 20000, 'preset save');
        await waitFor(() => stpd.presetChanges > armed.changes && ctx().chatCompletionSettings.preset_settings_openai === name, 20000, 'preset apply');
        // Allow preset-scoped regex scripts (SillyTavern otherwise asks the user once per preset).
        let regexCount = 0;
        try {
            const engine = await st('/scripts/extensions/regex/engine.js');
            engine.allowPresetScripts('openai', name);
            const scripts = ctx().getPresetManager('openai').readPresetExtensionField({ path: 'regex_scripts' });
            regexCount = Array.isArray(scripts) ? scripts.length : 0;
        } catch { /* regex extension unavailable */ }
        ctx().saveSettingsDebounced();
        return { ...(await ops.listPresets()), embedded_regex_scripts: regexCount };
    };

    ops.getPreset = async () => {
        const pm = ctx().getPresetManager('openai');
        const name = pm.getSelectedPresetName();
        return { name, preset: pm.getCompletionPresetByName(name) ?? null };
    };

    ops.characterAvatars = async () => ctx().characters.map(c => c.avatar);

    ops.characterImported = async ({ before }) => {
        const known = new Set(before);
        await waitFor(() => ctx().characters.some(c => !known.has(c.avatar)), 30000, 'character import');
        await sleep(300);
        const engine = await st('/scripts/extensions/regex/engine.js').catch(() => null);
        const added = ctx().characters.filter(c => !known.has(c.avatar));
        for (const ch of added) {
            try { engine?.allowScopedScripts(ch); } catch { /* ignore */ }
        }
        return added.map(ch => ({ name: ch.name, avatar: ch.avatar }));
    };

    ops.listCharacters = async () => {
        const c = ctx();
        return c.characters.map((ch, i) => ({ index: i, name: ch.name, avatar: ch.avatar, chat: ch.chat }));
    };

    ops.listChats = async ({ character }) => {
        const idx = findCharacterIndex(character);
        const ch = ctx().characters[idx];
        const list = await fetchChatList(ch.avatar);
        return list
            .map(x => ({ chat: x.file_name.replace(/\.jsonl$/, ''), messages: x.chat_items, last_message: x.mes?.slice?.(0, 200), last_date: x.last_mes }))
            .sort((a, b) => String(b.last_date).localeCompare(String(a.last_date)));
    };

    ops.getChat = async ({ character, chat, last }) => {
        if (character || chat) await prepareChat({ character, chat });
        const c = ctx();
        let msgs = c.chat.map(summarizeMessage);
        if (last) msgs = msgs.slice(-last);
        return { character: c.characters[c.characterId]?.name, chat: c.getCurrentChatId(), length: c.chat.length, messages: msgs };
    };

    ops.prepare = async (p) => {
        await prepareChat(p);
        const c = ctx();
        const last = c.chat[c.chat.length - 1];
        return {
            character: c.characters[c.characterId]?.name,
            chat: c.getCurrentChatId(),
            length: c.chat.length,
            last_is_user: !!last?.is_user,
        };
    };

    ops.newChat = async ({ character, history }) => {
        await prepareChat({ character, new_chat: true, history });
        return ops.getChat({});
    };

    /**
     * Core generation. type: 'normal' | 'regenerate'.
     * Batch replies are produced by one real generation (whose request is fanned out N times)
     * followed by N-1 swipes that are served from the already-received replies.
     */
    ops.generate = async ({ message, batch = 1, type = 'normal' }) => {
        const c = ctx();
        if (c.mainApi !== 'openai') fail('Main API is not Chat Completion. Call set_endpoint first.');
        const settings = c.chatCompletionSettings;
        const prevStream = settings.stream_openai;
        const prevN = settings.n;
        settings.stream_openai = false;
        if (typeof prevN === 'number') settings.n = 1;

        const fan = { n: batch, started: false, queue: [], served: [], all: null, results: null };
        stpd.gen.fanout = fan;
        const lenBefore = c.chat.length;
        let generateError = null;
        const swipeErrors = [];
        try {
            setTextarea(message ?? '');
            try {
                await c.generate(type);
            } catch (e) {
                generateError = String(e?.message || e);
            }
            const last = ctx().chat[ctx().chat.length - 1];
            const produced = last && !last.is_user && fan.started && fan.served.length > 0 && fan.served[0].ok;
            if (produced) {
                for (let i = 1; i < batch; i++) {
                    if (!fan.queue.length) break;
                    const before = last.swipes?.length ?? 1;
                    await c.executeSlashCommandsWithOptions('/swipe direction=right await=true');
                    await waitFor(() => (ctx().chat[ctx().chat.length - 1].swipes?.length ?? 1) > before || !fan.queue.length, 5000, 'swipe').catch(() => {});
                    const after = ctx().chat[ctx().chat.length - 1].swipes?.length ?? 1;
                    if (after <= before) swipeErrors.push(`swipe ${i} was not added`);
                }
            }
        } finally {
            settings.stream_openai = prevStream;
            if (typeof prevN === 'number') settings.n = prevN;
            stpd.gen.fanout = null;
            setTextarea('');
        }
        if (fan.results === null && fan.all) fan.results = await Promise.all(fan.all);
        // Let the swipe animation / its debounced save finish before touching the chat again.
        await waitFor(() => ctx().swipe.state() === 'none', 10000, 'swipe settle').catch(() => {});
        await sleep(300);
        await c.saveChat();

        const chat = ctx().chat;
        const last = chat[chat.length - 1];
        const added = !!(last && !last.is_user && fan.served.length && fan.served[0].ok);
        const servedSet = new Set(fan.served);
        const results = [];
        if (added) {
            const swipes = Array.isArray(last.swipes) ? last.swipes : [last.mes];
            fan.served.forEach((item, i) => {
                if (i >= swipes.length) return;
                results.push({
                    swipe_id: i,
                    request_index: item.index,
                    text: swipes[i],
                    reasoning: last.swipe_info?.[i]?.extra?.reasoning || undefined,
                    raw_text: (() => { try { return c.extractMessageFromData(item.json); } catch { return undefined; } })(),
                    finish_reason: finishReason(item.json),
                    usage: item.json?.usage ?? item.json?.usageMetadata ?? undefined,
                    latency_ms: item.ms,
                });
            });
        }
        // Keep the first reply as the canonical one after a batch (the swipe flow leaves the last one selected).
        if (added && results.length > 1 && last.swipe_id !== 0) {
            try { await ops.selectSwipe({ swipe_id: 0 }); } catch { /* non-fatal */ }
        }
        const failed = (fan.results || []).filter(it => !it.ok || !servedSet.has(it)).filter(it => !it.ok).map(it => ({
            request_index: it.index, error: it.error, status: it.status, latency_ms: it.ms,
        }));
        const requestBody = fan.results?.[0]?.body ?? null;
        return {
            character: c.characters[c.characterId]?.name,
            chat: c.getCurrentChatId(),
            message_index: added ? chat.length - 1 : null,
            user_message_added: chat.length > lenBefore && !!message,
            requested: batch,
            succeeded: results.length,
            results,
            failed,
            errors: [generateError, ...swipeErrors].filter(Boolean),
            request_body: requestBody,
            raw_responses: (fan.results || []).map(it => ({ index: it.index, status: it.status, body: it.json ?? it.text })),
        };
    };

    ops.lastMessageInfo = async () => {
        const chat = ctx().chat;
        const last = chat[chat.length - 1];
        return { length: chat.length, last_is_user: !!last?.is_user, last_is_system: !!last?.is_system };
    };

    ops.inspectPrompt = async ({ message }) => {
        const c = ctx();
        if (c.mainApi !== 'openai') fail('Main API is not Chat Completion. Call set_endpoint first.');
        const oai = await st('/scripts/openai.js');
        const chat = c.chat;
        const snapshot = chat.slice();
        let captured = null;
        const listener = (data) => { if (data?.dryRun) captured = structuredClone(data.chat); };
        c.eventSource.on(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, listener);
        try {
            if (message) chat.push(toStMessage({ role: 'user', content: message }));
            await c.generate('normal', {}, true);
        } finally {
            c.eventSource.removeListener(c.eventTypes.CHAT_COMPLETION_PROMPT_READY, listener);
            chat.splice(0, chat.length, ...snapshot);
        }
        if (!captured) fail('Prompt was not assembled (is a character selected and Chat Completion active?)');

        // Per-section breakdown from the prompt manager.
        const pm = oai.promptManager;
        const sections = [];
        // Leaves only, labelled with their prompt-manager section (group) identifier and name.
        const walk = (coll, group) => {
            for (const item of coll?.collection ?? []) {
                const id = item.identifier;
                if (Array.isArray(item.collection)) {
                    walk(item, { id, name: pm?.getPromptById?.(id)?.name });
                } else {
                    const own = pm?.getPromptById?.(id);
                    sections.push({
                        section: group?.id ?? id,
                        name: own?.name ?? group?.name,
                        identifier: id,
                        role: item.role,
                        tokens: item.tokens,
                        content: item.content,
                    });
                }
            }
        };
        try { walk(pm?.messages, null); } catch (e) { sections.push({ error: String(e) }); }

        let messages = captured;
        const settings = c.chatCompletionSettings;
        if (settings.squash_system_messages) {
            try {
                const cc = new oai.ChatCompletion();
                // Re-run squash on a copy via the class logic when possible.
                cc.messages = pm.messages;
                await cc.squashSystemMessages();
                messages = cc.getChat();
            } catch { /* keep unsquashed */ }
        }
        let requestBody = null;
        try {
            const model = oai.getChatCompletionModel(settings);
            const prevStream = settings.stream_openai;
            settings.stream_openai = false;
            try {
                const r = await oai.createGenerationParameters(settings, model, 'normal', messages);
                requestBody = r.generate_data;
            } finally {
                settings.stream_openai = prevStream;
            }
        } catch (e) {
            requestBody = { error: String(e?.message || e) };
        }
        let totalTokens;
        try { totalTokens = pm.tokenHandler?.getTotal?.(); } catch { /* ignore */ }
        return {
            character: c.characters[c.characterId]?.name,
            chat: c.getCurrentChatId(),
            preset: settings.preset_settings_openai,
            total_tokens: totalTokens,
            message_count: messages.length,
            messages,
            sections,
            request_body: requestBody,
        };
    };

    ops.inspectWithHistory = async ({ history, message }) => {
        const chat = ctx().chat;
        const original = chat.slice();
        try {
            await setHistory(history, { save: false });
            return await ops.inspectPrompt({ message });
        } finally {
            chat.splice(0, chat.length, ...original);
        }
    };

    ops.selectSwipe = async ({ swipe_id }) => {
        const c = ctx();
        const chat = c.chat;
        const mesId = chat.length - 1;
        const m = chat[mesId];
        if (!m || m.is_user || !Array.isArray(m.swipes)) fail('The last message has no swipes.');
        if (swipe_id >= m.swipes.length) fail(`swipe_id out of range (0..${m.swipes.length - 1})`);
        const script = await st('/script.js');
        if (script.syncSwipeToMes) {
            m.swipe_id = swipe_id;
            script.syncSwipeToMes(mesId, swipe_id);
        } else {
            m.swipe_id = swipe_id;
            m.mes = m.swipes[swipe_id];
        }
        await c.saveChat();
        await c.reloadCurrentChat();
        return summarizeMessage(ctx().chat[mesId], mesId);
    };

    // ---- extensions

    ops.listExtensions = async () => {
        const ext = await st('/scripts/extensions.js');
        const disabled = ext.extension_settings?.disabledExtensions ?? [];
        const res = await fetch('/api/extensions/discover', { headers: ctx().getRequestHeaders() });
        const found = res.ok ? await res.json() : [];
        const out = [];
        for (const e of found) {
            const name = e.type === 'system' || e.name.startsWith('third-party/') ? e.name : `third-party/${e.name}`;
            let manifest = null;
            try { manifest = ctx().getExtensionManifest?.(name) ?? null; } catch { /* ignore */ }
            out.push({
                name,
                type: e.type === 'system' ? 'built-in' : (e.type === 'global' ? 'third-party (global)' : 'third-party'),
                display_name: manifest?.display_name,
                version: manifest?.version,
                author: manifest?.author,
                enabled: !disabled.includes(name),
            });
        }
        return out;
    };

    ops.extensionRequest = async ({ endpoint, body }) => {
        const res = await fetch(`/api/extensions/${endpoint}`, {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify(body),
        });
        const text = await res.text();
        let data = text;
        try { data = JSON.parse(text); } catch { /* text */ }
        if (!res.ok) fail(`Extension ${endpoint} failed (${res.status}): ${text}`);
        return data;
    };

    ops.setExtensionEnabled = async ({ name, enabled }) => {
        const ext = await st('/scripts/extensions.js');
        const list = ext.extension_settings.disabledExtensions;
        const i = list.indexOf(name);
        if (enabled && i >= 0) list.splice(i, 1);
        if (!enabled && i < 0) list.push(name);
        const script = await st('/script.js');
        await script.saveSettings();
        return { name, enabled };
    };

    ops.getExtensionSettings = async ({ key }) => {
        const s = ctx().extensionSettings;
        if (!key) return { keys: Object.keys(s).sort() };
        if (!(key in s)) fail(`No extension_settings["${key}"]. Keys: ${Object.keys(s).sort().join(', ')}`);
        return s[key];
    };

    ops.setExtensionSettings = async ({ key, settings, merge }) => {
        const s = ctx().extensionSettings;
        const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
        const deepMerge = (target, src) => {
            for (const [k, v] of Object.entries(src)) {
                if (isObj(v) && isObj(target[k])) deepMerge(target[k], v);
                else target[k] = v;
            }
            return target;
        };
        if (merge && isObj(s[key]) && isObj(settings)) deepMerge(s[key], settings);
        else s[key] = settings;
        const script = await st('/script.js');
        await script.saveSettings();
        return s[key];
    };

    ops.runSlash = async ({ command }) => {
        const r = await ctx().executeSlashCommandsWithOptions(command);
        return { pipe: r?.pipe, isError: r?.isError, errorMessage: r?.errorMessage, isAborted: r?.isAborted };
    };

    ops.eval = async ({ code }) => {
        const fn = new Function('ctx', 'st', `return (async () => { ${code} })();`);
        const result = await fn(ctx(), st);
        return result === undefined ? null : JSON.parse(JSON.stringify(result, (k, v) => (typeof v === 'function' ? `[function ${v.name}]` : v)));
    };

    // ------------------------------------------------------------------ readiness

    const readyTimer = setInterval(() => {
        const S = window.SillyTavern;
        if (!S?.getContext) return;
        let c;
        try {
            c = S.getContext(); // throws while script.js is still initialising its module bindings
        } catch {
            return;
        }
        clearInterval(readyTimer);
        c.eventSource.on(c.eventTypes.APP_READY, () => { stpd.ready = true; stpd.autoPopup = null; });
        c.eventSource.on(c.eventTypes.OAI_PRESET_CHANGED_AFTER, () => { stpd.presetChanges++; });
    }, 50);
})();

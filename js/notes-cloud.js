/* Browser-only Supabase adapter. The original guest notes key is never migrated implicitly. */
(function () {
    "use strict";
    const ACCOUNT_PREFIX = "fast_quiz.notes.account.v1.";
    const token = note => JSON.stringify([note.questionKey, note.noteId]);
    const clone = value => JSON.parse(JSON.stringify(value));
    const stable = value => JSON.stringify(value, (_key, item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        return Object.assign(Object.create(null), ...Object.keys(item).sort().map(key => ({ [key]: item[key] })));
    });
    const entries = data => Object.values(data.notesByQuestion).flat();
    const count = data => entries(data).length;

    async function loadSDK(url) {
        if (window.supabase && window.supabase.createClient) return window.supabase;
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            const timer = setTimeout(() => reject(new Error("SDK_TIMEOUT")), 12000);
            script.src = url;
            script.async = true;
            script.onload = () => {
                clearTimeout(timer);
                window.supabase && window.supabase.createClient
                    ? resolve(window.supabase) : reject(new Error("SDK_UNAVAILABLE"));
            };
            script.onerror = () => { clearTimeout(timer); reject(new Error("SDK_UNAVAILABLE")); };
            document.head.appendChild(script);
        });
    }

    window.FastQuizCloud = {
        create(options) {
            const config = options.config;
            let client = null, user = null, epoch = 0, authTicket = 0, observedUser = null;
            let controller = null, running = null, wanted = false, signedOut = false;
            let ready = false, message = "正在載入登入功能；本機筆記仍可使用。";
            const scope = () => user ? user.id : "guest";
            const storageKey = uid => ACCOUNT_PREFIX + uid;
            const valid = (uid, generation) => !!user && user.id === uid && epoch === generation && !signedOut;
            const find = (data, note) => options.getQuestionNotes(data, note.questionKey).find(item => item.noteId === note.noteId);
            function put(data, note) {
                const list = [...options.getQuestionNotes(data, note.questionKey)];
                const index = list.findIndex(item => item.noteId === note.noteId);
                if (index === -1) list.push(clone(note));
                else list[index] = clone(note);
                Object.defineProperty(data.notesByQuestion, note.questionKey,
                    { value: list, enumerable: true, configurable: true, writable: true });
            }
            function newState(uid) {
                return { schemaVersion: 1, userId: uid, data: options.empty(), versions: {}, pending: {} };
            }
            function readState(uid) {
                const raw = localStorage.getItem(storageKey(uid));
                const state = raw === null ? newState(uid) : JSON.parse(raw);
                if (state.schemaVersion !== 1 || state.userId !== uid || !state.versions || !state.pending ||
                    typeof state.versions !== "object" || typeof state.pending !== "object" ||
                    Array.isArray(state.versions) || Array.isArray(state.pending)) throw new Error("CACHE_INVALID");
                options.validate(state.data);
                for (const version of Object.values(state.versions)) {
                    if (!Number.isSafeInteger(version) || version < 1) throw new Error("CACHE_INVALID");
                }
                for (const [id, job] of Object.entries(state.pending)) {
                    if (!job || typeof job.mutationId !== "string" || token(job.note) !== id ||
                        (job.expectedVersion !== null && (!Number.isSafeInteger(job.expectedVersion) || job.expectedVersion < 1))) {
                        throw new Error("CACHE_INVALID");
                    }
                    const sample = options.empty();
                    put(sample, job.note);
                    options.validate(sample);
                    if (stable(find(state.data, job.note)) !== stable(job.note)) throw new Error("CACHE_INVALID");
                }
                return state;
            }
            function persist(state) {
                options.validate(state.data);
                localStorage.setItem(storageKey(state.userId), JSON.stringify(state));
            }
            function queue(state, note, expectedVersion = state.versions[token(note)] || null) {
                state.pending[token(note)] = {
                    mutationId: crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random(),
                    expectedVersion, note: clone(note)
                };
            }
            function pendingCount() {
                try { return user ? Object.keys(readState(user.id).pending).length : 0; }
                catch (_) { return null; }
            }
            function emit() {
                let legacyCount = null;
                try { legacyCount = count(options.readLegacy()); } catch (_) {}
                options.onStatus({ user, ready, message, pending: pendingCount(), legacyCount });
            }
            function notify() { options.onData(); }
            function failMessage(error) {
                const code = error && error.code;
                if (code === "PGRST205" || code === "PGRST202" || code === "42P01" || code === "42501") {
                    return "已存本機，尚未同步：請確認建表 SQL、GRANT 與 RLS 設定。";
                }
                if (code === "PGRST301" || code === "PGRST303" || (error && error.status === 401)) {
                    return "已存本機，尚未同步：登入可能已過期，請重新登入。";
                }
                if (error && error.message === "CACHE_INVALID") return "帳號快取格式異常，已停止同步並保留原始資料。";
                return "已存本機，尚未同步：網路、儲存空間或雲端服務異常，可按「立即同步」重試。";
            }
            function abort() {
                epoch++;
                if (controller) controller.abort();
                controller = null;
                wanted = false;
                running = null;
            }
            function applySession(session) {
                if (signedOut && session) return;
                const nextUser = session ? session.user : null;
                if ((user && user.id) !== (nextUser && nextUser.id)) {
                    const previous = scope();
                    abort();
                    user = nextUser;
                    options.onScopeChange(previous, scope());
                    message = user ? "已登入，正在讀取雲端筆記。" : "未登入：使用原本機筆記。";
                    emit();
                    notify();
                }
                if (user) requestSync();
                else emit();
            }
            function scheduleSession(session) {
                if (signedOut && session) return;
                const uid = session && session.user.id;
                if (observedUser !== uid) {
                    observedUser = uid;
                    abort(); // Invalidate in-flight work immediately, without awaiting the Auth lock.
                }
                const ticket = ++authTicket;
                setTimeout(() => { if (ticket === authTicket) applySession(session); }, 0);
            }
            function fromRow(row) {
                if (!row || !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1) throw new Error("REMOTE_INVALID");
                const original = row.metadata && row.metadata.note || {};
                const date = (originalValue, serverValue) =>
                    originalValue && Date.parse(originalValue) === Date.parse(serverValue) ? originalValue : serverValue;
                const note = { ...original, questionKey: row.question_key, noteId: row.note_id, content: row.content,
                    createdAt: date(original.createdAt, row.created_at), updatedAt: date(original.updatedAt, row.updated_at) };
                const sample = options.empty();
                put(sample, note);
                options.validate(sample);
                return note;
            }
            async function conflictCopy(note) {
                const sourceNoteId = note.syncConflict ? note.syncConflict.sourceNoteId : note.noteId;
                const input = new TextEncoder().encode(JSON.stringify([note.questionKey, sourceNoteId, note.content]));
                const hash = await crypto.subtle.digest("SHA-256", input);
                const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
                return { ...note, noteId: "sync-conflict-v1:" + hex, syncConflict: { sourceNoteId } };
            }
            async function reconcile(row, uid, generation, acknowledged = null) {
                if (!valid(uid, generation) || row.user_id !== uid) return;
                const note = fromRow(row), id = token(note), version = Number(row.version);
                let state = readState(uid);
                if ((state.versions[id] || 0) > version) return;
                const job = state.pending[id];
                if (acknowledged) {
                    state.versions[id] = version;
                    if (job && job.mutationId !== acknowledged.mutationId) {
                        job.expectedVersion = version; // A later local save must remain queued.
                    } else {
                        delete state.pending[id];
                        put(state.data, note);
                    }
                } else if (!job) {
                    state.versions[id] = version;
                    put(state.data, note);
                } else if (stable(job.note) === stable(note)) {
                    state.versions[id] = version;
                    delete state.pending[id];
                    put(state.data, note);
                } else if (job.expectedVersion === version || job.note.content === note.content) {
                    state.versions[id] = version;
                    job.expectedVersion = version;
                } else {
                    const copy = await conflictCopy(job.note);
                    if (!valid(uid, generation)) return;
                    state = readState(uid);
                    if (!state.pending[id] || state.pending[id].mutationId !== job.mutationId) return;
                    const existing = find(state.data, copy);
                    if (existing && existing.content !== copy.content) throw new Error("CONFLICT_ID_COLLISION");
                    put(state.data, note);
                    state.versions[id] = version;
                    delete state.pending[id];
                    if (!existing) {
                        put(state.data, copy);
                        queue(state, copy);
                    } else if (!state.versions[token(copy)] && !state.pending[token(copy)]) {
                        queue(state, existing);
                    }
                }
                if (valid(uid, generation)) persist(state);
            }
            async function pull(uid, generation, signal) {
                let cursor = null;
                while (valid(uid, generation)) {
                    let query = client.from("quiz_notes").select("*").eq("user_id", uid)
                        .order("identity_hash", { ascending: true }).limit(200);
                    if (cursor !== null) query = query.gt("identity_hash", cursor);
                    const { data, error } = await query.abortSignal(signal);
                    if (!valid(uid, generation)) return;
                    if (error) throw error;
                    if (!Array.isArray(data)) throw new Error("REMOTE_INVALID");
                    if (data.length === 0) break; // Do not assume a short server-capped page is the last page.
                    for (const row of data) await reconcile(row, uid, generation);
                    const next = data[data.length - 1].identity_hash;
                    if (typeof next !== "string" || next === cursor) throw new Error("PAGINATION_INVALID");
                    cursor = next;
                }
            }
            async function push(job, uid, generation, signal) {
                const note = job.note;
                const { data, error } = await client.rpc("quiz_notes_write_v1", {
                    p_user_id: uid, p_question_key: note.questionKey, p_note_id: note.noteId, p_content: note.content,
                    p_created_at: note.createdAt, p_updated_at: note.updatedAt,
                    p_metadata: { note }, p_expected_version: job.expectedVersion
                }).abortSignal(signal);
                if (!valid(uid, generation)) return;
                if (error) throw error;
                if (data && data.status === "ok") {
                    await reconcile(data.note, uid, generation, job);
                } else if (data && data.status === "conflict") {
                    // Matching content also covers retry after an INSERT/UPDATE response was lost.
                    const remote = fromRow(data.note);
                    await reconcile(data.note, uid, generation, remote.content === note.content ? job : null);
                } else if (data && data.status === "missing") {
                    const state = readState(uid);
                    if (state.pending[token(note)] && state.pending[token(note)].mutationId === job.mutationId) {
                        state.pending[token(note)].expectedVersion = null;
                        delete state.versions[token(note)];
                        persist(state);
                    }
                } else throw new Error("REMOTE_INVALID");
            }
            function requestSync() {
                if (!user || !client || signedOut) return Promise.resolve();
                wanted = true;
                if (running) return running;
                const uid = user.id, generation = epoch;
                controller = new AbortController();
                const signal = controller.signal;
                const task = (async () => {
                    try {
                        while (wanted && valid(uid, generation)) {
                            wanted = false;
                            message = "同步中…";
                            emit();
                            await pull(uid, generation, signal);
                            let attempts = 0;
                            while (valid(uid, generation)) {
                                const jobs = Object.values(readState(uid).pending);
                                if (!jobs.length) break;
                                if (++attempts > 10000) throw new Error("SYNC_RETRY_LIMIT");
                                await push(clone(jobs[0]), uid, generation, signal);
                            }
                            if (valid(uid, generation)) {
                                notify();
                                message = pendingCount() === 0 ? "已同步" : "已存本機，尚未同步";
                                emit();
                            }
                        }
                    } catch (error) {
                        if (valid(uid, generation)) {
                            wanted = false;
                            message = failMessage(error);
                            notify();
                            emit();
                        }
                    }
                })();
                running = task;
                task.finally(() => {
                    if (running === task) {
                        running = null;
                        if (wanted && valid(uid, generation)) requestSync();
                    }
                });
                return task;
            }
            const api = {
                scope,
                read() {
                    if (user && observedUser !== user.id) throw new Error("ACCOUNT_CHANGING");
                    return user ? clone(readState(user.id).data) : options.readLegacy();
                },
                versionFor(note) { return user ? readState(user.id).versions[token(note)] || null : undefined; },
                write(data, context = {}) {
                    options.validate(data);
                    if (!user) {
                        options.writeLegacy(data);
                        return;
                    }
                    if (observedUser !== user.id || signedOut) throw new Error("ACCOUNT_CHANGING");
                    const state = readState(user.id);
                    for (const note of entries(data)) {
                        const current = find(state.data, note);
                        if (!current || stable(current) !== stable(note)) {
                            put(state.data, note);
                            let expected = state.pending[token(note)] ? state.pending[token(note)].expectedVersion : state.versions[token(note)] || null;
                            if (context.questionKey === note.questionKey && context.noteId === note.noteId &&
                                context.expectedVersion !== undefined && current && current.content !== context.baseContent) {
                                expected = context.expectedVersion; // Editor was opened before an incoming remote change.
                            }
                            queue(state, note, expected);
                        }
                    }
                    try {
                        persist(state); // Data and durable outbox share one atomic localStorage write.
                    } catch (error) {
                        message = "本機保存失敗，草稿仍保留，未送出雲端。";
                        emit();
                        throw error;
                    }
                    message = "已存本機，尚未同步";
                    emit();
                    requestSync();
                },
                sync: requestSync,
                async signIn(email, password) {
                    if (!client || !ready) throw new Error("登入功能尚未載入，請稍後重試或重新整理。");
                    signedOut = false;
                    const { error } = await client.auth.signInWithPassword({ email, password });
                    if (error) throw new Error(error.code === "invalid_credentials" ? "Email 或密碼不正確。" :
                        error.code === "email_not_confirmed" ? "此 APP 帳號尚未確認 Email，請在後台確認。" :
                            "登入失敗，請檢查網路、Email、密碼及 APP 帳號設定。");
                },
                async signOut() {
                    signedOut = true;
                    authTicket++;
                    observedUser = null;
                    applySession(null);
                    let error = null;
                    try { ({ error } = await client.auth.signOut({ scope: "local" })); }
                    finally {
                        // Remove only this app's Auth token; never remove any note/cache key.
                        try { localStorage.removeItem(config.authStorageKey); } catch (_) {}
                    }
                    message = error ? "已在此瀏覽器登出；遠端撤銷連線失敗。本機筆記仍可使用。" : "未登入：使用原本機筆記。";
                    emit();
                },
                migrate() {
                    if (!user) throw new Error("請先登入目前帳號。");
                    const merged = options.merge(api.read(), options.readLegacy());
                    api.write(merged.data);
                    notify();
                    return merged.counts;
                },
                savedMessage() { return user ? "已存本機，尚未同步" : "已保存"; },
                async init() {
                    emit();
                    try {
                        const sdk = await loadSDK(config.sdkUrl);
                        client = sdk.createClient(config.url, config.publishableKey, {
                            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: config.authStorageKey }
                        });
                        // Synchronous callback: never await an SDK call while its Auth lock is held.
                        client.auth.onAuthStateChange((_event, session) => scheduleSession(session));
                        const { data, error } = await client.auth.getSession();
                        if (error) throw error;
                        ready = true;
                        if (authTicket === 0) scheduleSession(data.session);
                        message = "未登入：使用原本機筆記。";
                        emit();
                    } catch (_) {
                        ready = false;
                        message = "登入服務未能載入；刷題、本機筆記與匯出／匯入仍可使用。請檢查網路後重新整理。";
                        emit();
                    }
                }
            };
            window.addEventListener("online", () => requestSync());
            document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestSync(); });
            window.addEventListener("storage", event => {
                if (user && event.key === storageKey(user.id)) { notify(); emit(); requestSync(); }
            });
            return api;
        }
    };
})();

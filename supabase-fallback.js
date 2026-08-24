(function () {
    const STORAGE_KEY = 'reading_cosmos_supabase_session';

    function createClient(baseUrl, anonKey) {
        let session = readSession();

        function readSession() {
            try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
            catch { return null; }
        }

        function saveSession(nextSession) {
            session = nextSession || null;
            if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
            else localStorage.removeItem(STORAGE_KEY);
        }

        function authHeaders(useSession = true) {
            return {
                apikey: anonKey,
                Authorization: `Bearer ${useSession && session?.access_token ? session.access_token : anonKey}`,
                'Content-Type': 'application/json'
            };
        }

        async function readResponse(response) {
            const text = await response.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; }
            catch { body = text || null; }
            if (!response.ok) {
                const message = body?.msg || body?.message || body?.error_description || body?.error || `HTTP ${response.status}`;
                return { data: null, error: { message, status: response.status } };
            }
            return { data: body, error: null };
        }

        async function refreshSessionIfNeeded() {
            if (!session?.refresh_token) return session;
            const expiresAt = Number(session.expires_at || 0) * 1000;
            if (expiresAt && expiresAt - Date.now() > 60000) return session;
            try {
                const response = await fetch(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
                    method: 'POST', headers: authHeaders(false),
                    body: JSON.stringify({ refresh_token: session.refresh_token })
                });
                const result = await readResponse(response);
                if (!result.error && result.data?.access_token) saveSession(normalizeSession(result.data));
            } catch { /* Keep the existing session so callers can return the network error. */ }
            return session;
        }

        function normalizeSession(payload) {
            if (!payload?.access_token) return null;
            return {
                access_token: payload.access_token,
                refresh_token: payload.refresh_token,
                expires_at: payload.expires_at || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600),
                user: payload.user || session?.user || null
            };
        }

        async function authRequest(path, body) {
            try {
                const response = await fetch(`${baseUrl}${path}`, {
                    method: 'POST', headers: authHeaders(false), body: JSON.stringify(body)
                });
                return await readResponse(response);
            } catch (error) {
                return { data: null, error: { message: error.message || '网络连接失败' } };
            }
        }

        class QueryBuilder {
            constructor(table) {
                this.table = table;
                this.method = 'GET';
                this.params = new URLSearchParams();
                this.body = undefined;
                this.headers = {};
                this.singleMode = false;
            }

            select(columns = '*') { this.params.set('select', columns); return this; }
            eq(column, value) { this.params.append(column, `eq.${value}`); return this; }
            order(column, options = {}) { this.params.set('order', `${column}.${options.ascending === false ? 'desc' : 'asc'}`); return this; }
            limit(value) { this.params.set('limit', String(value)); return this; }
            single() { this.singleMode = true; this.headers.Accept = 'application/vnd.pgrst.object+json'; return this; }
            maybeSingle() { this.singleMode = true; this.headers.Accept = 'application/vnd.pgrst.object+json'; return this; }
            upsert(value, options = {}) {
                this.method = 'POST'; this.body = value;
                this.headers.Prefer = 'resolution=merge-duplicates,return=representation';
                if (options.onConflict) this.params.set('on_conflict', options.onConflict);
                return this;
            }
            update(value) {
                this.method = 'PATCH'; this.body = value;
                this.headers.Prefer = 'return=representation';
                return this;
            }
            delete() { this.method = 'DELETE'; this.headers.Prefer = 'return=minimal'; return this; }

            then(resolve, reject) { return this.execute().then(resolve, reject); }

            async execute() {
                await refreshSessionIfNeeded();
                const query = this.params.toString();
                try {
                    const response = await fetch(`${baseUrl}/rest/v1/${encodeURIComponent(this.table)}${query ? `?${query}` : ''}`, {
                        method: this.method,
                        headers: { ...authHeaders(), ...this.headers },
                        body: this.body === undefined ? undefined : JSON.stringify(this.body)
                    });
                    if (this.singleMode && response.status === 406) return { data: null, error: null };
                    const result = await readResponse(response);
                    if (this.singleMode && Array.isArray(result.data)) result.data = result.data[0] || null;
                    return result;
                } catch (error) {
                    return { data: null, error: { message: error.message || '网络连接失败' } };
                }
            }
        }

        return {
            auth: {
                async signInWithPassword(credentials) {
                    const result = await authRequest('/auth/v1/token?grant_type=password', credentials);
                    if (result.error) return result;
                    const nextSession = normalizeSession(result.data);
                    saveSession(nextSession);
                    return { data: { user: nextSession?.user || null, session: nextSession }, error: null };
                },
                async signUp(credentials) {
                    const result = await authRequest('/auth/v1/signup', credentials);
                    if (result.error) return result;
                    const nextSession = normalizeSession(result.data);
                    if (nextSession) saveSession(nextSession);
                    return { data: { user: result.data?.user || null, session: nextSession }, error: null };
                },
                async getUser() {
                    await refreshSessionIfNeeded();
                    if (!session?.access_token) return { data: { user: null }, error: null };
                    try {
                        const response = await fetch(`${baseUrl}/auth/v1/user`, { headers: authHeaders() });
                        const result = await readResponse(response);
                        if (result.error) return { data: { user: null }, error: result.error };
                        session.user = result.data;
                        saveSession(session);
                        return { data: { user: result.data }, error: null };
                    } catch (error) {
                        return { data: { user: null }, error: { message: error.message || '网络连接失败' } };
                    }
                },
                async getSession() {
                    await refreshSessionIfNeeded();
                    return { data: { session }, error: null };
                },
                async signOut() {
                    try {
                        if (session?.access_token) await fetch(`${baseUrl}/auth/v1/logout`, { method: 'POST', headers: authHeaders() });
                    } finally { saveSession(null); }
                    return { error: null };
                }
            },
            from(table) { return new QueryBuilder(table); },
            functions: {
                async invoke(name, options = {}) {
                    await refreshSessionIfNeeded();
                    try {
                        const response = await fetch(`${baseUrl}/functions/v1/${encodeURIComponent(name)}`, {
                            method: 'POST', headers: authHeaders(), body: JSON.stringify(options.body || {})
                        });
                        return await readResponse(response);
                    } catch (error) {
                        return { data: null, error: { message: error.message || '网络连接失败' } };
                    }
                }
            }
        };
    }

    window.createReadingCosmosSupabaseFallback = createClient;
})();

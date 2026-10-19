const encoder = new TextEncoder();
export const defaults = {
    enabled: true,
    vertexai_service_tier: 'auto', vertexai_request_type: 'auto', vertexai_api_version: 'auto',
    vertexai_timeout: 1200, vertexai_auto_continue: true,
    vertexai_argument_streaming: true, vertexai_unwrap_content: true,
};

/** Adapt complete provider frames to the unmodified SillyTavern 1.19 parser. */
export function adaptFrame(frame, state = { toolIndex: 0 }, streaming = true) {
    const tools = [];
    const candidates = frame.candidates || (frame.responseContent ? [{ index: 0, content: frame.responseContent }] : []);
    for (const candidate of candidates) {
        const parts = candidate.content?.parts;
        if (!Array.isArray(parts)) continue;
        const kept = [];
        let text = '', thought = '', signature;
        for (const part of parts) {
            if (part.functionCall) {
                const call = part.functionCall;
                tools.push({ index: state.toolIndex++, id: call.id || `vertex_${crypto.randomUUID()}`, type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
                    ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) });
            } else if (typeof part.text === 'string' || part.thoughtSignature) {
                if (part.thought) thought += part.text || '';
                else {
                    text += part.text || '';
                    signature = part.thoughtSignature || signature;
                }
                if (part.inlineData) kept.push({ inlineData: part.inlineData, thought: part.thought });
            } else kept.push(part);
        }
        // Stock getStreamingReply reads only the first text and thought part.
        candidate.content.parts = [{ text, ...(signature ? { thoughtSignature: signature } : {}) },
            ...(thought ? [{ text: thought, thought: true }] : []), ...kept];
    }
    if (tools.length) {
        if (streaming) frame.choices = [{ index: 0, delta: { tool_calls: tools } }];
        else {
            // Stock non-streaming Google tool conversion replaces provider IDs; use its OpenAI tool path.
            delete frame.responseContent;
            frame.choices = [{ index: 0, message: {
                content: candidates[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '',
                tool_calls: tools.map(({ index, ...tool }) => tool),
            } }];
        }
    }
    return frame;
}

export function adaptStream(response, notify = () => {}) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { toolIndex: 0 };
    let pending = '', completed = false, released = false, eof = false;
    const release = () => { if (!released) { released = true; reader.releaseLock(); } };
    return new Response(new ReadableStream({
        async pull(controller) {
            try {
                while (true) {
                    const boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending);
                    if (!boundary) {
                        if (eof) throw new Error('Vertex 连接中断，未收到完整结束标记。已保留收到的正文。');
                        const next = await reader.read();
                        eof = next.done;
                        pending += eof ? decoder.decode() : decoder.decode(next.value, { stream: true });
                        if (pending.length > 32 * 1024 * 1024) throw new Error('Vertex 流事件超过 32 MiB。');
                        continue;
                    }
                    const raw = pending.slice(0, boundary.index);
                    pending = pending.slice(boundary.index + boundary[0].length);
                    const payload = raw.split(/\r\n|\n|\r/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
                    if (!payload) { controller.enqueue(encoder.encode(raw + '\n\n')); return; }
                    if (payload === '[DONE]') {
                        if (!completed) throw new Error('Vertex 数据流提前结束，已收到的正文可能不完整。');
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        await reader.cancel(); release(); controller.close(); return;
                    }
                    const frame = JSON.parse(payload);
                    notify(frame);
                    if (frame.error) throw new Error(frame.error.message || 'Vertex 请求失败。');
                    if (frame.vertexMeta?.phase === 'completed') completed = true;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(adaptFrame(frame, state))}\n\n`));
                    // Deliver one event per pull so a later error cannot discard queued text.
                    return;
                }
            } catch (error) {
                notify(error.name === 'AbortError' ? { vertexMeta: { phase: 'cancelled' } } : { error: { message: error.message } });
                await reader.cancel(error).catch(() => {}); release(); controller.error(error);
            }
        },
        async cancel(reason) {
            await reader.cancel(reason).catch(() => {}); release();
        },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createVertexFetch(previous, { baseUrl, getSettings, notify = () => {} }) {
    return async function vertexFetch(input, init) {
        const call = () => previous.call(this, input, init);
        if (!getSettings().enabled) return call();
        const requestLike = input && typeof input.url === 'string' && typeof input.clone === 'function';
        const url = new URL(requestLike ? input.url : String(input), baseUrl);
        if (url.origin !== new URL(baseUrl).origin) return call();
        const match = /^(.*)\/api\/(?:backends\/chat-completions|plugins\/turing-stream-bridge)\/generate$/.exec(url.pathname);
        if (!match || match[1].includes('/api/plugins/')) return call();
        const request = new Request(requestLike ? input.clone() : url, init);
        if (request.method !== 'POST') return call();
        let body;
        try { body = await request.json(); } catch { return call(); }
        if (body?.chat_completion_source !== 'vertexai') return call();
        const settings = getSettings();
        for (const key of Object.keys(defaults)) if (key !== 'enabled') body[key] = settings[key] ?? defaults[key];
        const target = new URL(`${match[1]}/api/plugins/vertex-native/api/backends/chat-completions/generate`, url.origin);
        const routed = { method: 'POST', headers: request.headers, body: JSON.stringify(body),
            signal: request.signal, credentials: request.credentials, mode: request.mode, cache: request.cache,
            redirect: request.redirect, referrer: request.referrer, referrerPolicy: request.referrerPolicy };
        notify(null);
        try {
            // String URL + init.body also works with helpers running in a different iframe realm.
            const response = await previous.call(this, target.href, routed);
            if (!response.ok) {
                let detail;
                try { detail = (await response.clone().json()).error?.message; } catch { /* May be a proxy HTML page. */ }
                throw new Error(detail || (response.status === 404
                    ? 'Vertex 服务端插件尚未加载：安装插件、开启 enableServerPlugins 并重启酒馆。'
                    : `Vertex 插件返回 HTTP ${response.status}。`));
            }
            if (!response.headers.get('x-st-vertex-native')) throw new Error('此响应未经过 Vertex 服务端插件，请检查安装及反向代理路径。');
            if (body.stream === true) return adaptStream(response, notify);
            const data = await response.json();
            notify(data);
            if (data.error) throw new Error(data.error.message || 'Vertex 请求失败。');
            return new Response(JSON.stringify(adaptFrame(data, { toolIndex: 0 }, false)),
                { status: response.status, headers: response.headers });
        } catch (error) {
            notify(error.name === 'AbortError' ? { vertexMeta: { phase: 'cancelled' } } : { error: { message: error.message } });
            throw error;
        }
    };
}

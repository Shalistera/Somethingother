import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptFrame, adaptStream, createVertexFetch, defaults } from '../frontend/transport.js';

const baseUrl = 'http://localhost:8000/';
const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const candidate = parts => ({ candidates: [{ index: 0, content: { role: 'model', parts } }] });
const completion = frame({ vertexMeta: { phase: 'completed' } }) + 'data: [DONE]\n\n';
const reply = text => new Response(text, { headers: { 'content-type': 'text/event-stream', 'x-st-vertex-native': '1.1.0' } });
const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' },
    body: JSON.stringify({ chat_completion_source: 'vertexai', stream: true, model: 'gemini-4-argon', messages: [{ role: 'user', content: 'test' }] }) };

// This models the existing helper's endpoint classifier and request-injection order.
const helper = next => async (input, options) => {
    const request = new Request(input, options);
    if (!/\/api\/backends\/[^/]+\/generate\b/.test(request.url)) return next(input, options);
    const body = await request.clone().json();
    body.tools = [{ type: 'function', function: { name: 'actual_content' } }];
    return next(new Request(request, { body: JSON.stringify(body) }));
};

test('routes Vertex with original helper in either load order; preserves CSRF and paid tier', async () => {
    for (const order of ['helper-first', 'extension-first']) {
        let called = 0;
        const network = async (source, options) => {
            const input = new Request(source, options);
            called++;
            assert.equal(new URL(input.url).pathname, '/api/plugins/vertex-native/api/backends/chat-completions/generate');
            assert.equal(input.headers.get('x-csrf-token'), 'test');
            const body = await input.json();
            assert.equal(body.vertexai_service_tier, 'priority');
            assert.equal(body.tools[0].function.name, 'actual_content');
            return reply(frame(candidate([{ text: '结果' }])) + completion);
        };
        const wrap = fn => createVertexFetch(fn, { baseUrl, getSettings: () => ({ ...defaults, vertexai_service_tier: 'priority' }) });
        const fetcher = order === 'helper-first' ? wrap(helper(network)) : helper(wrap(network));
        assert.match(await (await fetcher(baseUrl + 'api/backends/chat-completions/generate', init)).text(), /结果/);
        assert.equal(called, 1);
    }
});

test('other providers, disabled extension, and unrelated requests pass through unchanged', async () => {
    const other = { ...init, body: JSON.stringify({ chat_completion_source: 'openai' }) };
    for (const [settings, url, opts] of [[defaults, baseUrl + 'api/backends/chat-completions/generate', other],
        [{ ...defaults, enabled: false }, baseUrl + 'api/backends/chat-completions/generate', init],
        [defaults, baseUrl + 'api/settings/get', init]]) {
        const fetcher = createVertexFetch((input, options) => {
            assert.equal(input, url); assert.equal(options, opts); return new Response('unchanged');
        }, { baseUrl, getSettings: () => settings });
        assert.equal(await (await fetcher(url, opts)).text(), 'unchanged');
    }
});

test('unmodified client receives all text and preserves provider tool IDs and signatures', () => {
    const original = candidate([{ text: '甲' }, { text: '思考一', thought: true }, { text: '乙' }, { text: '思考二', thought: true },
        { thoughtSignature: 'text-signature' }, { functionCall: { id: 'provider-id', name: 'lookup', args: { a: 1 } }, thoughtSignature: 'tool-signature' }]);
    const adapted = adaptFrame(structuredClone(original));
    assert.equal(adapted.candidates[0].content.parts[0].text, '甲乙');
    assert.equal(adapted.candidates[0].content.parts[0].thoughtSignature, 'text-signature');
    assert.equal(adapted.candidates[0].content.parts[1].text, '思考一思考二');
    assert.equal(adapted.choices[0].delta.tool_calls[0].id, 'provider-id');
    assert.equal(adapted.choices[0].delta.tool_calls[0].signature, 'tool-signature');
    const plain = adaptFrame({ ...structuredClone(original), responseContent: structuredClone(original.candidates[0].content) }, { toolIndex: 0 }, false);
    assert.equal(plain.responseContent, undefined);
    assert.equal(plain.choices[0].message.tool_calls[0].id, 'provider-id');
});

test('stream errors and clean premature EOF reject without silently losing earlier text', async () => {
    for (const tail of [frame({ error: { message: 'simulated disconnect' } }), '', 'data: [DONE]\n\n']) {
        const reader = adaptStream(reply(frame(candidate([{ text: '保留正文' }])) + tail)).body.getReader();
        let text = '', failed = false;
        try { while (true) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); } }
        catch { failed = true; }
        assert.equal(failed, true);
        assert.ok(text.includes('保留正文'));
    }
});

test('cancelling the adapted browser stream cancels the network reader', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(': connected\n\n')); }, cancel() { cancelled = true; } }));
    const reader = adaptStream(response).body.getReader();
    await reader.read(); await reader.cancel();
    assert.equal(cancelled, true);
});

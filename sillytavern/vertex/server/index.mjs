import fs from 'node:fs';
import path from 'node:path';
import { hostRoot, packageVersion } from './host.mjs';
import { sendVertexRequest } from './vertex.mjs';
import { streamDebug } from './debug.mjs';

export const info = {
    id: 'vertex-native',
    name: 'Vertex Native',
    description: 'Direct Vertex streaming, heartbeats, function arguments, continuation and diagnostics.',
};

export async function init(router) {
    router.use((req, res, next) => {
        if (!req.user?.directories?.root) return res.sendStatus(401);
        res.set('Cache-Control', 'no-store');
        next();
    });
    router.get('/health', (_req, res) => res.json({
        id: info.id, version: '1.1.0', sillyTavern: packageVersion,
        corePatchPresent: /import\s+\{\s*sendVertexRequest\s*\}/.test(fs.readFileSync(path.join(hostRoot, 'src/endpoints/backends/chat-completions.js'), 'utf8')),
    }));
    router.use('/debug', streamDebug.router);
    const generate = (req, res) => {
        if (req.body?.chat_completion_source !== 'vertexai') return res.status(400).json({ error: { message: 'This endpoint accepts Vertex AI requests only.' } });
        return sendVertexRequest(req, res);
    };
    router.post('/generate', generate);
    // Retain the native suffix so existing Tavern Helper fetch interceptors recognize the request.
    router.post('/api/backends/chat-completions/generate', generate);
}

export async function exit() {
    await streamDebug.close();
}

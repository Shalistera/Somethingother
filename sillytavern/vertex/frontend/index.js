import { createVertexFetch, defaults } from './transport.js';

// Works for both global and per-user extension install paths.
const appBase = new URL(import.meta.url);
appBase.pathname = appBase.pathname.slice(0, appBase.pathname.indexOf('/scripts/extensions/')) + '/';
const { extension_settings } = await import(new URL('scripts/extensions.js', appBase));
const { eventSource, event_types, saveSettingsDebounced, getRequestHeaders } = await import(new URL('script.js', appBase));
const openai = await import(new URL('scripts/openai.js', appBase));
const key = 'vertex_native';
const getSettings = () => ({ ...defaults, ...extension_settings[key] });
let panel, runtime = {}, lastError = '', errorAt = 0;

function notify(frame) {
    if (!panel) return;
    const output = panel.querySelector('[data-runtime]');
    if (frame === null) { runtime = { chars: 0 }; lastError = ''; output.classList.remove('vertex-native-error'); }
    else {
        Object.assign(runtime, frame.vertexMeta || {});
        if (frame.usageMetadata?.trafficType) runtime.trafficType = frame.usageMetadata.trafficType;
        if (frame.vertexMeta?.phase === 'completed') runtime.tokens = frame.usageMetadata?.totalTokenCount;
        const text = frame.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '';
        runtime.chars = (runtime.chars || 0) + text.length;
        if (text) runtime.phase = 'receiving';
        if (frame.error) {
            output.textContent = frame.error.message;
            output.classList.add('vertex-native-error');
            if (lastError !== frame.error.message || Date.now() - errorAt > 5000) {
                globalThis.toastr?.error(frame.error.message, 'Vertex Native');
                lastError = frame.error.message; errorAt = Date.now();
            }
            return;
        }
    }
    const phases = { authentication: '正在认证', waiting_for_vertex: '等待 Vertex', receiving: '接收正文', continuation: '正在接续', completed: '本次响应已结束', cancelled: '已停止' };
    const details = [phases[runtime.phase] || '正在连接'];
    if (runtime.chars) details.push(`${runtime.chars} 字`);
    if (runtime.trafficType) details.push(runtime.trafficType);
    if (runtime.segments > 1) details.push(`${runtime.segments} 段`);
    if (Number.isFinite(runtime.tokens)) details.push(`${runtime.tokens} tokens`);
    if (runtime.warning) details.push(runtime.warning);
    const text = details.join(' · ');
    if (output.textContent !== text) output.textContent = text;
}

// Install before helper extensions; the routed endpoint also supports their opposite load order.
if (!window.__vertexNativeInstalled) {
    window.__vertexNativeInstalled = true;
    window.fetch = createVertexFetch(window.fetch, { baseUrl: appBase.href, getSettings, notify });
}

async function checkConnection() {
    const output = panel.querySelector('[data-connection]');
    output.textContent = '检查服务端插件…';
    try {
        const response = await fetch(new URL('api/plugins/vertex-native/health', appBase), { headers: getRequestHeaders(), cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 404 ? '请安装服务端插件，开启 enableServerPlugins 后重启酒馆。' : `服务端返回 HTTP ${response.status}`);
        const health = await response.json();
        if (health.id !== 'vertex-native') throw new Error('服务端插件响应不匹配。');
        output.textContent = `服务端 ${health.version} 已连接` + (health.corePatchPresent ? '；检测到旧 Vertex 源码补丁，可按迁移说明卸载。' : '');
    } catch (error) { output.textContent = error.message; }
}

function modelOptions() {
    const select = document.getElementById('model_vertexai_select');
    if (select && !Array.from(select.options).some(x => x.value === 'gemini-4-argon')) select.add(new Option('gemini-4-argon', 'gemini-4-argon'));
    if (openai.oai_settings.chat_completion_source === 'vertexai') {
        const found = openai.model_list.find(x => x.id === 'gemini-4-argon');
        if (!found) openai.model_list.push({ id: 'gemini-4-argon', inputTokenLimit: 1048576, outputTokenLimit: 1048576 });
        else found.inputTokenLimit = 1048576;
    }
    const regions = document.getElementById('vertexai_region_suggestions');
    if (regions) for (const region of ['global', 'us', 'eu']) {
        if (!Array.from(regions.options).some(x => x.value === region)) regions.append(new Option(region, region));
    }
}

function mount() {
    if (panel) return;
    if (!extension_settings[key]) {
        const inherited = Object.fromEntries(Object.keys(defaults).filter(k => k !== 'enabled' && openai.oai_settings[k] !== undefined).map(k => [k, openai.oai_settings[k]]));
        extension_settings[key] = { ...defaults, ...inherited };
        saveSettingsDebounced();
    }
    panel = document.createElement('details');
    panel.id = 'vertex-native-settings';
    panel.innerHTML = `<summary>Vertex Native</summary><div class="vertex-native-grid">
        <label class="checkbox_label"><input type="checkbox" data-key="enabled"><span>启用 Vertex Native</span></label>
        <label>服务档位<select class="text_pole" data-key="vertexai_service_tier"><option value="auto">默认（Google 自动分配）</option><option value="standard">Standard</option><option value="priority">Priority（更高价格）</option><option value="flex">Flex（当前不支持 Argon）</option></select></label>
        <label>使用容量<select class="text_pole" data-key="vertexai_request_type"><option value="auto">自动</option><option value="shared">仅按量付费</option><option value="dedicated">仅已购买的专用容量</option></select></label>
        <label>API 版本<select class="text_pole" data-key="vertexai_api_version"><option value="auto">自动</option><option value="v1">v1</option><option value="v1beta1">v1beta1</option></select></label>
        <label>整次生成等待上限（秒）<input class="text_pole" data-key="vertexai_timeout" type="number" min="30" max="7200" step="1"></label>
        <label class="checkbox_label"><input type="checkbox" data-key="vertexai_auto_continue"><span>Argon 自动接续官方长输出分段</span></label>
        <label class="checkbox_label"><input type="checkbox" data-key="vertexai_argument_streaming"><span>函数参数流式传输</span></label>
        <label class="checkbox_label"><input type="checkbox" data-key="vertexai_unwrap_content"><span>将图灵 actual_content 转为正文</span></label>
        <small>沿用 Google Vertex AI 连接里的模型、密钥和区域。每 10 秒自动保活；图灵工具定义继续由原脚本提供。</small>
        <small class="vertex-native-status" data-connection></small><small class="vertex-native-status" data-runtime role="status" aria-live="polite"></small>
        <div class="vertex-native-actions"><button class="menu_button" type="button" data-check>检查连接</button><a class="menu_button" data-debug target="_blank" rel="noopener">断连诊断</a></div>
    </div>`;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!container) { panel = null; return; }
    container.append(panel);
    for (const field of panel.querySelectorAll('[data-key]')) {
        const name = field.dataset.key, fallback = defaults[name];
        if (typeof fallback === 'boolean') field.checked = getSettings()[name];
        else field.value = getSettings()[name];
        field.addEventListener('change', () => {
            if (!field.checkValidity()) { field.reportValidity(); field.value = getSettings()[name]; return; }
            extension_settings[key][name] = typeof fallback === 'boolean' ? field.checked : typeof fallback === 'number' ? Number(field.value) : field.value;
            saveSettingsDebounced();
        });
    }
    panel.querySelector('[data-debug]').href = new URL('api/plugins/vertex-native/debug', appBase).href;
    panel.querySelector('[data-check]').addEventListener('click', checkConnection);
    document.getElementById('chat_completion_source')?.addEventListener('change', modelOptions);
    document.getElementById('model_vertexai_select')?.addEventListener('change', modelOptions, true);
    modelOptions();
    void checkConnection();
}

eventSource.on(event_types.APP_READY, mount);
eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, data => {
    if (data.chat_completion_source !== 'vertexai' || !getSettings().enabled) return;
    for (const [name, value] of Object.entries(getSettings())) if (name !== 'enabled') data[name] = value;
});

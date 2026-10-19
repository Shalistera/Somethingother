// Adapted from SillyTavern 1.19.0, GNU AGPL v3.
import { getConfigValue, tryParse } from './host.mjs';
const GEMINI_MEDIA_RESOLUTION = { low: 'media_resolution_low', high: 'media_resolution_high' };
const enableThoughtSignatures = !!getConfigValue('gemini.thoughtSignatures', true, 'boolean');

export function convertGooglePrompt(messages, model, useSysPrompt, names) {
    const sysPrompt = [];

    if (useSysPrompt) {
        while (messages.length > 1 && messages[0].role === 'system') {
            // Append example names if not already done by the frontend (e.g. for group chats).
            if (names.userName && messages[0].name === 'example_user') {
                if (!messages[0].content.startsWith(`${names.userName}: `)) {
                    messages[0].content = `${names.userName}: ${messages[0].content}`;
                }
            }
            if (names.charName && messages[0].name === 'example_assistant') {
                if (!messages[0].content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(messages[0].content)) {
                    messages[0].content = `${names.charName}: ${messages[0].content}`;
                }
            }
            sysPrompt.push(messages[0].content);
            messages.shift();
        }
    }

    const system_instruction = { parts: sysPrompt.map(text => ({ text })) };
    const toolNameMap = {};

    // https://ai.google.dev/gemini-api/docs/latest-model#prefilled-model-turn-validation
    const noPrefillModel = /gemini-3\.[678]-flash|gemini-3\.5-flash-lite|gemini-4-argon/.test(model);

    const contents = [];
    messages.forEach((message, index) => {
        // fix the roles
        if (message.role === 'system' || message.role === 'tool') {
            message.role = 'user';
        } else if (message.role === 'assistant') {
            // A trailing model turn is a prefill, which is rejected by the newest models
            message.role = noPrefillModel && index === messages.length - 1 ? 'user' : 'model';
        }

        // Convert the content to an array of parts
        if (!Array.isArray(message.content)) {
            const content = (() => {
                const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
                const hasToolCallId = typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0;

                if (hasToolCalls) {
                    return { type: 'tool_calls', tool_calls: message.tool_calls };
                }

                if (hasToolCallId) {
                    return { type: 'tool_call_id', tool_call_id: message.tool_call_id, content: String(message.content ?? '') };
                }

                return { type: 'text', text: String(message.content ?? '') };
            })();
            message.content = [content];
        }

        // similar story as claude
        if (message.name) {
            message.content.forEach((part) => {
                if (part.type !== 'text') {
                    return;
                }
                if (message.name === 'example_user') {
                    if (names.userName && !part.text.startsWith(`${names.userName}: `)) {
                        part.text = `${names.userName}: ${part.text}`;
                    }
                } else if (message.name === 'example_assistant') {
                    if (names.charName && !part.text.startsWith(`${names.charName}: `) && !names.startsWithGroupName(part.text)) {
                        part.text = `${names.charName}: ${part.text}`;
                    }
                } else {
                    if (!part.text.startsWith(`${message.name}: `)) {
                        part.text = `${message.name}: ${part.text}`;
                    }
                }
            });

            delete message.name;
        }

        //create the prompt parts
        const parts = [];
        message.content.forEach((part) => {
            const addDataUrlPart = (/** @type {string} */ url, /** @type {string} */ defaultMimeType, /** @type {string?} */ detail = null) => {
                if (url && url.startsWith('data:')) {
                    const [header, base64Data] = url.split(',');
                    const mimeType = header.match(/data:([^;]+)/)?.[1] || defaultMimeType;
                    const mediaResolution = GEMINI_MEDIA_RESOLUTION[detail] || null;

                    const part = {
                        inlineData: {
                            mimeType: mimeType,
                            data: base64Data,
                        },
                    };

                    // https://ai.google.dev/gemini-api/docs/gemini-3#media_resolution
                    if (/gemini-[34]/.test(model) && mediaResolution) {
                        part.mediaResolution = {
                            level: mediaResolution,
                        };
                    }

                    parts.push(part);
                }
            };

            if (part.type === 'text') {
                parts.push({ text: part.text });
            } else if (part.type === 'tool_call_id') {
                const name = toolNameMap[part.tool_call_id] ?? 'unknown';
                parts.push({
                    functionResponse: {
                        ...(/^gemini-4/.test(model) ? { id: part.tool_call_id } : {}),
                        name: name,
                        response: { name: name, content: part.content },
                    },
                });
            } else if (part.type === 'tool_calls') {
                part.tool_calls.forEach((toolCall) => {
                    parts.push({
                        functionCall: {
                            ...(/^gemini-4/.test(model) ? { id: toolCall.id } : {}),
                            name: toolCall.function.name,
                            args: tryParse(toolCall.function.arguments) ?? toolCall.function.arguments,
                        },
                        ...(toolCall.signature ? { thoughtSignature: toolCall.signature } : {}),
                    });

                    toolNameMap[toolCall.id] = toolCall.function.name;
                });
            } else if (part.type === 'image_url') {
                const imageUrl = part.image_url?.url;
                const detail = part.image_url?.detail;
                addDataUrlPart(imageUrl, 'image/png', detail);
            } else if (part.type === 'video_url') {
                const videoUrl = part.video_url?.url;
                const detail = part.video_url?.detail;
                addDataUrlPart(videoUrl, 'video/mp4', detail);
            } else if (part.type === 'audio_url') {
                const audioUrl = part.audio_url?.url;
                addDataUrlPart(audioUrl, 'audio/mpeg');
            }
        });

        // https://ai.google.dev/gemini-api/docs/gemini-3#migrating_from_other_models
        // Inject stored thought signatures, or fall back to bypass magic for Gemini 3
        if (/gemini-[34]/.test(model) || /gemini-2\.5/.test(model)) {
            const skipSignatureMagic = 'skip_thought_signature_validator';
            const textSignature = message.signature;

            parts.forEach((part) => {
                if (enableThoughtSignatures && textSignature && typeof part.text === 'string') {
                    part.thoughtSignature = textSignature;
                } else if (/gemini-[34]/.test(model)) {
                    // Gemini 3: Fall back to bypass magic for function calls (mandatory) and images
                    if (part.functionCall && !part.thoughtSignature) {
                        part.thoughtSignature = skipSignatureMagic;
                    }
                    if (/-image/.test(model) && message.role === 'model') {
                        if (typeof part.text === 'string' || part.inlineData) {
                            part.thoughtSignature = skipSignatureMagic;
                        }
                    }
                }
                // Gemini 2.5 without stored signatures: signatures are optional, no bypass needed
            });
        }

        // merge consecutive messages with the same role
        if (index > 0 && message.role === contents[contents.length - 1].role) {
            parts.forEach((part) => {
                if (part.text && !part.thoughtSignature) {
                    const textPart = contents[contents.length - 1].parts.find(p => typeof p.text === 'string' && !p.thoughtSignature);
                    if (textPart) {
                        textPart.text += '\n\n' + part.text;
                    } else {
                        contents[contents.length - 1].parts.push(part);
                    }
                }
                if (part.inlineData || part.functionCall || part.functionResponse || part.thoughtSignature || part.mediaResolution) {
                    contents[contents.length - 1].parts.push(part);
                }
            });
        } else {
            contents.push({
                role: message.role,
                parts: parts,
            });
        }
    });

    return { contents: contents, system_instruction: system_instruction };
}

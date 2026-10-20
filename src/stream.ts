import crypto from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";
import {
  buildAuthHeaders,
  formatQoderHttpError,
  getMachineId,
  getQoderChatURL,
  getQoderCNDirectModel,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
  logCosyRequest,
  logCosyResponse,
} from "./cosy.js";
import {
  getCachedModelConfig,
  type QoderModelEntry,
  qoderSupportsThinkingEffort,
  resolveRequestedThinkingEffort,
  withQoderThinkingEffort,
} from "./models.js";
import { resolveQoderIdentity } from "./oauth.js";
import { qoderEncodeBody } from "./qoder-encoding.js";
import { requestsSummary, withCheckpointRecovery } from "./response-guard.js";
import { applyQoderUsage, type QoderTokenUsage, qoderStopReason } from "./stream-metadata.js";
import { ThinkingTagParser } from "./thinking-parser.js";
import { type QoderContext, resolveQoderContext, transformMessagesForQoder, transformTools } from "./transform.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  contentIndex: number;
}

interface QoderToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface QoderResponseDelta {
  reasoning_content?: string;
  content?: string;
  tool_calls?: QoderToolCallDelta[];
}

interface QoderResponseChoice {
  delta?: QoderResponseDelta;
  finish_reason?: string | null;
}

interface QoderSseEnvelope {
  statusCodeValue?: number;
  body?: string;
}

interface QoderSseBody {
  choices?: QoderResponseChoice[];
  usage?: QoderTokenUsage;
}

function parseToolCallArguments(state: ToolCallState): Record<string, unknown> {
  if (!state.arguments.trim()) return {};
  const identity = state.name || state.id || "unknown";

  let parsed: unknown;
  try {
    parsed = JSON.parse(state.arguments);
  } catch {
    throw new Error(`Qoder tool call arguments are not valid JSON (${identity})`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Qoder tool call arguments must be a JSON object (${identity})`);
  }
  return parsed as Record<string, unknown>;
}

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
  sessionID: string,
  system: string,
): string {
  // Tool-call arguments, prompt changes and session identity are part of a
  // request too; hashing only message.content aliases distinct requests.
  return stableHash(
    "qoder-record",
    model,
    sessionID,
    system,
    JSON.stringify(messages),
    JSON.stringify(tools ?? []),
    String(maxTokens),
  );
}

export function streamQoder(
  model: Model<Api>,
  context: QoderContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const resolved = resolveQoderContext(context);
  const lastUser = [...resolved.messages].reverse().find((message) => message.role === "user");
  const lastUserText = lastUser ? transformMessagesForQoder([lastUser])[0]?.content : "";
  const requestedText = typeof lastUserText === "string" ? lastUserText : JSON.stringify(lastUserText ?? "");
  // Host compaction is tool-free. Explicit user summaries must remain valid.
  if (resolved.tools.length === 0 || requestsSummary(requestedText)) return streamQoderAttempt(model, context, options);
  return withCheckpointRecovery((recovery) => streamQoderAttempt(model, context, options, recovery), options?.signal);
}

function streamQoderAttempt(
  model: Model<Api>,
  context: QoderContext,
  options?: SimpleStreamOptions,
  recovery = false,
): AssistantMessageEventStream {
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  (async () => {
    try {
      options?.signal?.throwIfAborted();
      const providerMode = model.provider === "qoder-cn" ? "cn" : getQoderMode();
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error(
          isQoderCNMode(providerMode)
            ? "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN / QODERCN_PAT (or QODER_API_KEY=pt-...)."
            : "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.",
        );
      }

      // Resolve identity: auth.json fast path → in-process cache → /userinfo(access).
      // Cold start only has options.apiKey (access); do NOT decode refresh here.
      // Never invent a placeholder userID — the gateway returns opaque HTTP 500.
      const identity = await resolveQoderIdentity(accessToken, model.provider, providerMode);
      const userID = identity.userID;
      const name = identity.name || (isQoderCNMode(providerMode) ? "Qoder CN User" : "Qoder User");
      const email = identity.email || getQoderUserEmailFallback(providerMode);
      const machineID = identity.machineID || getMachineId();

      const aliasKey = isQoderCNMode(providerMode) ? getQoderCNDirectModel(model.id) : model.id;
      const cachedConfig = getCachedModelConfig(model.id, providerMode) || getCachedModelConfig(aliasKey, providerMode);
      // Prefer the live catalog wire key over static alias tables.
      const qoderModel = cachedConfig?.key || aliasKey;
      const fallbackConfig: QoderModelEntry = {
        key: qoderModel,
        is_reasoning: !!model.reasoning,
        max_output_tokens: model.maxTokens || 32768,
        source: "system",
      };
      const baseConfig = cachedConfig || fallbackConfig;
      const requestedEffort = resolveRequestedThinkingEffort(options?.reasoning as unknown);
      const appliedEffort =
        requestedEffort && qoderSupportsThinkingEffort(baseConfig, requestedEffort) ? requestedEffort : undefined;
      const modelConfig = appliedEffort ? withQoderThinkingEffort(baseConfig, appliedEffort) : baseConfig;
      modelConfig.key = qoderModel;

      const isReasoning = !!modelConfig.is_reasoning;
      const maxOutputTokens = modelConfig.max_output_tokens || 32768;

      const resolvedContext = resolveQoderContext(context);
      const normalizedMessages = transformMessagesForQoder(resolvedContext.messages);
      const systemText = recovery
        ? `${resolvedContext.systemPrompt}\n\nThis is not a context-compaction request. Answer the latest user task using the supplied conversation and tool results. Do not replace the answer with an internal conversation checkpoint.`
        : resolvedContext.systemPrompt;

      let lastUserText = "";
      for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role === "user") {
          const content = normalizedMessages[i].content;
          lastUserText =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c) => ("text" in c ? c.text : "")).join("")
                : "";
          break;
        }
      }

      let maxTokens = 32768;
      if (maxOutputTokens > 0) {
        maxTokens = maxOutputTokens;
      }
      if (options?.maxTokens && options.maxTokens < maxTokens) {
        maxTokens = options.maxTokens;
      }

      const toolsRaw = resolvedContext.tools.length > 0 ? transformTools(resolvedContext.tools) : undefined;
      // Never share one remote conversation across every chat for this account.
      // Tool-free one-off summarization has a separate prompt-scoped identity.
      const sessionScope = recovery ? crypto.randomUUID() : options?.sessionId || crypto.randomUUID();
      const sessionID = stableHash(
        "qoder-session",
        providerMode,
        userID,
        qoderModel,
        sessionScope,
        toolsRaw ? "agent" : systemText,
      );
      const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens, sessionID, systemText);

      const reqBody: Record<string, unknown> = {
        request_id: crypto.randomUUID(),
        request_set_id: recordID,
        chat_record_id: recordID,
        session_id: sessionID,
        stream: true,
        chat_task: "FREE_INPUT",
        is_reply: true,
        is_retry: false,
        source: 1,
        version: "3",
        session_type: "qodercli",
        agent_id: "agent_common",
        task_id: "common",
        code_language: "",
        chat_prompt: "",
        image_urls: null,
        aliyun_user_type: "",
        system: systemText,
        messages: normalizedMessages,
        tools: toolsRaw || [],
        parameters: {
          max_tokens: maxTokens,
          ...(appliedEffort ? { reasoning_effort: appliedEffort } : {}),
        },
        chat_context: {
          chatPrompt: "",
          imageUrls: null,
          extra: {
            context: [],
            modelConfig: {
              key: qoderModel,
              is_reasoning: isReasoning,
            },
            originalContent: lastUserText,
          },
          features: [],
          text: lastUserText,
        },
        model_config: modelConfig,
        business: {
          product: "cli",
          version: "1.0.0",
          type: "agent",
          stage: "start",
          id: crypto.randomUUID(),
          name: lastUserText.substring(0, 30),
          begin_at: Date.now(),
        },
      };
      if (process.env.QODER_LOG_MODEL_CONFIG === "1") {
        const selectedEffort = Object.entries(modelConfig.thinking_config?.enabled?.efforts || {}).find(
          ([, config]) => config?.is_default,
        )?.[0];
        console.log(
          JSON.stringify({
            event: "qoder_request_model_config",
            model_key: qoderModel,
            is_reasoning: modelConfig.is_reasoning,
            requested_effort: requestedEffort,
            applied_effort: appliedEffort,
            selected_effort: selectedEffort,
            enable_thinking: modelConfig.thinking_config?.enabled?.is_default === true,
          }),
        );
      }

      const payload = (await options?.onPayload?.(reqBody, model)) ?? reqBody;
      options?.signal?.throwIfAborted();
      const bodyBytes = Buffer.from(JSON.stringify(payload));
      const encodedBody = qoderEncodeBody(bodyBytes);
      const encodedBytes = Buffer.from(encodedBody, "utf8");

      const chatURL = getQoderChatURL(providerMode);

      const headers = buildAuthHeaders(encodedBytes, chatURL, {
        userID,
        authToken: accessToken,
        name,
        email,
        machineID,
      });
      logCosyRequest("POST", chatURL, headers);

      const modelSource = modelConfig.source || "system";

      const response = await fetch(chatURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
          "X-Model-Key": qoderModel,
          "X-Model-Source": modelSource,
          ...headers,
        },
        body: encodedBytes,
        signal: options?.signal,
      });
      await options?.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
        model,
      );
      await logCosyResponse(chatURL, response);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(formatQoderHttpError("api", response.status, response.statusText, errText, chatURL));
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      let finishReason: string | undefined;
      let usage: QoderTokenUsage = {};

      let contentBlockIndex = -1;
      let thinkingBlockIndex = -1;
      const toolCallsState = new Map<number, ToolCallState>();

      const thinkingEnabled = (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";
      const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;

      stream.push({ type: "start", partial: output });

      try {
        while (!completed) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          if (done && buffer && !buffer.endsWith("\n")) buffer += "\n";

          while (true) {
            const lineEnd = buffer.indexOf("\n");
            if (lineEnd === -1) break;

            const line = buffer.substring(0, lineEnd).trim();
            buffer = buffer.substring(lineEnd + 1);

            if (!line.startsWith("data:")) continue;

            const dataStr = line.substring(5).trim();
            if (dataStr === "[DONE]") {
              completed = true;
              break;
            }

            let envelope: QoderSseEnvelope;
            try {
              envelope = JSON.parse(dataStr) as QoderSseEnvelope;
            } catch {
              throw new Error("Qoder SSE envelope is not valid JSON");
            }
            if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
              throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
            }

            const innerStr = envelope.body;
            if (innerStr === "[DONE]") {
              completed = true;
              break;
            }
            if (!innerStr) continue;

            let inner: QoderSseBody;
            try {
              inner = JSON.parse(String(innerStr)) as QoderSseBody;
            } catch {
              throw new Error("Qoder SSE response body is not valid JSON");
            }
            // Optional on modern Pi, absent from older SDK typings. No payloads
            // are logged by the provider; inspection is explicitly host-controlled.
            const observer = (
              options as
                | (SimpleStreamOptions & {
                    onProviderStreamEvent?: (event: unknown, model: Model<Api>) => void | Promise<void>;
                  })
                | undefined
            )?.onProviderStreamEvent;
            await observer?.(inner, model);
            if (inner.usage) {
              usage = {
                ...usage,
                ...inner.usage,
                prompt_tokens_details: {
                  ...usage.prompt_tokens_details,
                  ...inner.usage.prompt_tokens_details,
                },
              };
              applyQoderUsage(output, usage, model);
            }
            if (inner.choices && inner.choices.length > 0) {
              const choice = inner.choices[0];
              if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
              const delta = choice.delta;

              if (delta) {
                // 1. Process reasoning/thinking content (API reasoning)
                if (delta.reasoning_content) {
                  if (thinkingBlockIndex === -1) {
                    thinkingBlockIndex = output.content.length;
                    output.content.push({ type: "thinking", thinking: "" });
                    stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
                  }
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  block.thinking += delta.reasoning_content;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingBlockIndex,
                    delta: delta.reasoning_content,
                    partial: output,
                  });
                }

                // 2. Process text content
                if (delta.content) {
                  // End API thinking block if active
                  if (thinkingBlockIndex !== -1) {
                    const block = output.content[thinkingBlockIndex] as ThinkingContent;
                    stream.push({
                      type: "thinking_end",
                      contentIndex: thinkingBlockIndex,
                      content: block.thinking,
                      partial: output,
                    });
                    thinkingBlockIndex = -1;
                  }

                  if (thinkingParser) {
                    thinkingParser.processChunk(delta.content);
                  } else {
                    if (contentBlockIndex === -1) {
                      contentBlockIndex = output.content.length;
                      output.content.push({ type: "text", text: "" });
                      stream.push({ type: "text_start", contentIndex: contentBlockIndex, partial: output });
                    }
                    const block = output.content[contentBlockIndex] as TextContent;
                    block.text += delta.content;
                    stream.push({
                      type: "text_delta",
                      contentIndex: contentBlockIndex,
                      delta: delta.content,
                      partial: output,
                    });
                  }
                }

                // 3. Process tool calls
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    let state = toolCallsState.get(idx);
                    if (!state) {
                      state = {
                        arguments: "",
                        id: tc.id || "",
                        name: tc.function?.name || "",
                        contentIndex: output.content.length,
                      };
                      toolCallsState.set(idx, state);
                      output.content.push({
                        type: "toolCall",
                        id: state.id,
                        name: state.name,
                        arguments: {},
                      });
                      stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
                    }

                    const block = output.content[state.contentIndex] as ToolCall;
                    if (tc.id) {
                      state.id = tc.id;
                      block.id = tc.id;
                    }
                    if (tc.function?.name) {
                      state.name = tc.function.name;
                      block.name = tc.function.name;
                    }

                    const argDelta = tc.function?.arguments || "";
                    state.arguments += argDelta;
                    stream.push({
                      type: "toolcall_delta",
                      contentIndex: state.contentIndex,
                      delta: argDelta,
                      partial: output,
                    });
                  }
                }
              }
            }
          }
          if (done) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      options?.signal?.throwIfAborted();
      if (!completed && !finishReason) throw new Error("Qoder stream ended without a completion marker");

      if (thinkingParser) {
        thinkingParser.finalize();
      } else if (contentBlockIndex !== -1) {
        stream.push({
          type: "text_end",
          contentIndex: contentBlockIndex,
          content: (output.content[contentBlockIndex] as TextContent).text,
          partial: output,
        });
      }

      if (thinkingBlockIndex !== -1) {
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingBlockIndex,
          content: block.thinking,
          partial: output,
        });
      }

      for (const state of toolCallsState.values()) {
        const args = parseToolCallArguments(state);
        const block = output.content[state.contentIndex] as ToolCall;
        block.arguments = args;
        stream.push({
          type: "toolcall_end",
          contentIndex: state.contentIndex,
          toolCall: {
            type: "toolCall",
            id: state.id,
            name: state.name,
            arguments: args,
          },
          partial: output,
        });
      }

      if (output.content.length === 0) {
        throw new Error("Qoder upstream completed without assistant content");
      }

      output.stopReason = qoderStopReason(finishReason, toolCallsState.size > 0);
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (e: unknown) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = e instanceof Error ? e.message : String(e);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    }
  })();

  return stream;
}

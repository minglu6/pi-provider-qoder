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
import { isQoderAuthExpired, QoderAuthExpiredError, type RenewQoderAccess } from "./auth-recovery.js";
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
import { type DsmlAttempt, streamWithDsmlRecovery } from "./dsml-stream.js";
import { applyQoderThinkingOptions, getCachedModelConfig, type QoderModelEntry } from "./models.js";
import { resolveQoderIdentity } from "./oauth.js";
import { qoderEncodeBody } from "./qoder-encoding.js";
import { applyQoderUsage, type QoderTokenUsage, qoderStopReason } from "./stream-metadata.js";
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
  if (!state.id.trim() || !state.name.trim()) {
    throw new Error("Qoder tool call is missing its id or function name");
  }
  const identity = state.name;
  if (!state.arguments.trim()) return {};

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
  settings: unknown,
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
    JSON.stringify(settings),
  );
}

export function streamQoder(
  model: Model<Api>,
  context: QoderContext,
  options?: SimpleStreamOptions,
  renewAccess?: RenewQoderAccess,
): AssistantMessageEventStream {
  const auth = { renewAccess, retried: false, accessToken: options?.apiKey };
  if (/deepseek/i.test(`${model.id} ${model.name}`) || /^(?:d|df)model$/u.test(model.id)) {
    const { tools } = resolveQoderContext(context);
    if (tools.length) {
      return streamWithDsmlRecovery(model, context, tools, options, (cleanContext, inspection) =>
        streamQoderAttempt(model, cleanContext, { ...options, apiKey: auth.accessToken }, auth, inspection),
      );
    }
  }
  return streamQoderAttempt(model, context, options, auth);
}

function streamQoderAttempt(
  model: Model<Api>,
  context: QoderContext,
  options?: SimpleStreamOptions,
  auth?: { renewAccess?: RenewQoderAccess; retried: boolean; accessToken?: string },
  inspection?: DsmlAttempt,
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
    let started = false;
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
      // Pi omits reasoning when disabled; only send a disable mode the catalog supports.
      const requestedEffort: unknown = options?.reasoning ?? (baseConfig.thinking_config?.disabled ? false : undefined);
      const { modelConfig: thinkingConfig, effort: appliedEffort } = applyQoderThinkingOptions(
        baseConfig,
        requestedEffort,
      );
      const modelConfig = { ...thinkingConfig, key: qoderModel };
      const thinkingEnabled =
        requestedEffort === false || requestedEffort === "off"
          ? false
          : requestedEffort === true || appliedEffort !== undefined
            ? true
            : undefined;

      const isReasoning = !!modelConfig.is_reasoning;
      const maxOutputTokens = modelConfig.max_output_tokens || 32768;

      const resolvedContext = resolveQoderContext(context);
      const normalizedMessages = transformMessagesForQoder(resolvedContext.messages);
      const systemText = resolvedContext.systemPrompt;
      // The gateway forwards OpenAI-style messages, not the top-level system field.
      const messages = systemText
        ? [{ role: "system", content: systemText }, ...normalizedMessages]
        : normalizedMessages;

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

      const parameters = {
        max_tokens: maxTokens,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(thinkingEnabled !== undefined ? { enable_thinking: thinkingEnabled } : {}),
        ...(thinkingEnabled === false
          ? { reasoning_effort: "none" }
          : appliedEffort
            ? { reasoning_effort: appliedEffort }
            : {}),
      };

      const toolsRaw = resolvedContext.tools.length > 0 ? transformTools(resolvedContext.tools) : undefined;
      // Never share one remote conversation across every chat for this account.
      // Tool-free one-off summarization has a separate prompt-scoped identity.
      const sessionScope = inspection?.regeneration || options?.sessionId || crypto.randomUUID();
      const sessionID = stableHash(
        "qoder-session",
        providerMode,
        userID,
        qoderModel,
        sessionScope,
        toolsRaw ? "agent" : systemText,
      );
      const recordID = stableChatRecordID(
        qoderModel,
        messages,
        toolsRaw,
        { parameters, modelConfig },
        sessionID,
        systemText,
      );

      const reqBody: Record<string, unknown> = {
        request_id: crypto.randomUUID(),
        request_set_id: recordID,
        chat_record_id: recordID,
        session_id: sessionID,
        stream: true,
        chat_task: "FREE_INPUT",
        is_reply: true,
        is_retry: !!inspection?.regeneration,
        source: 1,
        version: "3",
        session_type: "qodercli",
        agent_id: "agent_common",
        task_id: "common",
        code_language: "",
        chat_prompt: "",
        image_urls: null,
        aliyun_user_type: "",
        messages,
        tools: toolsRaw || [],
        parameters,
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
      if (inspection) {
        inspection.allowRecovery =
          typeof payload === "object" &&
          payload !== null &&
          "tools" in payload &&
          (!("tool_choice" in payload) ||
            payload.tool_choice === undefined ||
            payload.tool_choice === "auto" ||
            payload.tool_choice === "required") &&
          JSON.stringify(payload.tools) === JSON.stringify(transformTools(resolvedContext.tools));
      }
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

      const requestHeaders = new Headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "Accept-Encoding": "identity",
        "X-Model-Key": qoderModel,
        "X-Model-Source": modelSource,
        ...headers,
      });
      const protectedHeaders = new Set([
        ...Object.keys(headers).map((name) => name.toLowerCase()),
        "authorization",
        "proxy-authorization",
        "host",
        "content-length",
        "content-type",
        "transfer-encoding",
        "connection",
        "x-model-key",
        "x-model-source",
      ]);
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        if (protectedHeaders.has(name.toLowerCase()) || name.toLowerCase().startsWith("cosy-")) {
          throw new Error(`Cannot override Qoder-managed header: ${name}`);
        }
        if (value === null) requestHeaders.delete(name);
        else requestHeaders.set(name, value);
      }

      const response = await fetch(chatURL, {
        method: "POST",
        headers: requestHeaders,
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
        if (isQoderAuthExpired(response.status, errText)) {
          throw new QoderAuthExpiredError(
            formatQoderHttpError("api", response.status, response.statusText, errText, chatURL),
          );
        }
        throw new Error(formatQoderHttpError("api", response.status, response.statusText, errText, chatURL));
      }

      const reader = response.body?.getReader();
      // The upstream gateway can return authentication errors inside HTTP 200 SSE.
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      let finishReason: string | undefined;
      let usage: QoderTokenUsage = {};

      let thinkingBlockIndex = -1;
      const toolCallsState = new Map<number, ToolCallState>();

      let textBlockIndex = -1;
      const endContent = () => {
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
        if (textBlockIndex !== -1) {
          const block = output.content[textBlockIndex] as TextContent;
          stream.push({ type: "text_end", contentIndex: textBlockIndex, content: block.text, partial: output });
          textBlockIndex = -1;
        }
      };

      stream.push({ type: "start", partial: output });
      started = true;

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
              if (isQoderAuthExpired(envelope.statusCodeValue, envelope.body ?? "")) {
                throw new QoderAuthExpiredError(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
              }
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
                    endContent();
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
                  if (textBlockIndex === -1) {
                    endContent();
                    textBlockIndex = output.content.length;
                    output.content.push({ type: "text", text: "" });
                    stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
                  }
                  const block = output.content[textBlockIndex] as TextContent;
                  block.text += delta.content;
                  stream.push({
                    type: "text_delta",
                    contentIndex: textBlockIndex,
                    delta: delta.content,
                    partial: output,
                  });
                }

                // 3. Process tool calls
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    endContent();
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

      endContent();
      if (inspection) {
        inspection.complete = true;
        inspection.finishReason = finishReason;
      }

      for (const state of toolCallsState.values()) {
        const block = output.content[state.contentIndex] as ToolCall;
        block.arguments = parseToolCallArguments(state);
      }
      for (const state of toolCallsState.values()) {
        const block = output.content[state.contentIndex] as ToolCall;
        stream.push({
          type: "toolcall_end",
          contentIndex: state.contentIndex,
          toolCall: {
            type: "toolCall",
            id: state.id,
            name: state.name,
            arguments: block.arguments,
          },
          partial: output,
        });
      }

      const stopReason = qoderStopReason(finishReason, toolCallsState.size > 0);
      output.stopReason = stopReason;
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (e: unknown) {
      let failure = e;
      if (
        e instanceof QoderAuthExpiredError &&
        auth?.renewAccess &&
        !auth.retried &&
        output.content.length === 0 &&
        !options?.signal?.aborted
      ) {
        auth.retried = true;
        try {
          auth.accessToken = await auth.renewAccess(options?.apiKey ?? "", options?.sessionId);
          options?.signal?.throwIfAborted();
          const retry = streamQoderAttempt(model, context, { ...options, apiKey: auth.accessToken }, auth, inspection);
          for await (const event of retry) {
            if (event.type !== "start" || !started) stream.push(event);
          }
          stream.end();
          return;
        } catch (renewalError) {
          failure = renewalError;
        }
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = failure instanceof Error ? failure.message : String(failure);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    }
  })();

  return stream;
}

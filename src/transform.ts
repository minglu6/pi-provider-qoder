import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";

// Structural types keep this provider usable with both pre-transcript Pi/OMP
// and modern Pi without requiring old hosts to export the new transcript types.
interface QoderSystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: Array<{ name: string }>;
  timestamp: number;
}

export interface QoderContext {
  messages: Array<Message | QoderSystemMessage>;
  systemPrompt?: string | string[];
  tools?: Tool[];
}

/** Resolve transcript deltas before mapping to Qoder's top-level prompt/tools. */
export function resolveQoderContext(context: QoderContext): {
  systemPrompt: string;
  tools: Tool[];
  messages: Message[];
} {
  const messages = context.messages.filter((message): message is Message => message.role !== "system");
  if (!context.messages.some((message) => message.role === "system")) {
    // OMP supplies ordered prompt sections; Qoder requires a single string.
    const systemPrompt = Array.isArray(context.systemPrompt)
      ? context.systemPrompt.join("\n\n")
      : (context.systemPrompt ?? "");
    return { systemPrompt, tools: context.tools ?? [], messages };
  }

  // Pi supplies these helpers at runtime. Older Pi/OMP and the legacy SDK don't,
  // so avoid named imports that would prevent the extension from loading there.
  const transcript = PiAi as unknown as {
    getCurrentSystemPrompt?: (messages: QoderContext["messages"]) => string;
    getCurrentTools?: (messages: QoderContext["messages"]) => Tool[];
  };
  if (transcript.getCurrentSystemPrompt && transcript.getCurrentTools) {
    return {
      systemPrompt: transcript.getCurrentSystemPrompt(context.messages),
      tools: transcript.getCurrentTools(context.messages),
      messages,
    };
  }

  // Compatibility for a transcript passed through a host with the older SDK.
  // Once system messages exist, their state is authoritative, even when empty.
  const content: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, Tool>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    const text =
      typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
    if (text) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return {
    systemPrompt: [...content, ...sections.values()].filter((text) => text.length > 0).join("\n\n"),
    tools: [...tools.values()],
    messages,
  };
}

/** OpenAI-style tool definition sent to the Qoder API. */
interface QoderTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

/** OpenAI-style tool call within an assistant message. */
interface QoderToolCall {
  id?: string;
  type: "function";
  function: { name?: string; arguments: string };
}

type QoderTextPart = { type: "text"; text: string };
type QoderImagePart = { type: "image_url"; image_url: { url: string } };
type QoderContent = string | Array<QoderTextPart | QoderImagePart>;

/** OpenAI-style message sent to the Qoder API. */
interface QoderMessage {
  role: "user" | "assistant" | "tool";
  content: QoderContent | null;
  reasoning_content?: string;
  tool_calls?: QoderToolCall[];
  tool_call_id?: string;
}

export function getContentText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

function transformContentForQoder(msg: Message): QoderContent {
  if (!Array.isArray(msg.content) || !msg.content.some((block) => block.type === "image")) {
    return getContentText(msg);
  }

  return msg.content
    .map((block): QoderTextPart | QoderImagePart | null => {
      if (block.type === "text") {
        return { type: "text", text: (block as TextContent).text };
      }
      if (block.type === "image") {
        const image = block as ImageContent;
        return {
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        };
      }
      return null;
    })
    .filter((part): part is QoderTextPart | QoderImagePart => part !== null);
}

export function transformTools(tools: Tool[]): QoderTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function transformMessagesForQoder(messages: Message[]): QoderMessage[] {
  const normalizedMessages: QoderMessage[] = [];

  for (const msg of messages) {
    // Skip error or aborted messages
    if (
      msg.role === "assistant" &&
      ((msg as AssistantMessage).stopReason === "error" || (msg as AssistantMessage).stopReason === "aborted")
    ) {
      continue;
    }

    if (msg.role === "user") {
      const content = transformContentForQoder(msg);
      normalizedMessages.push({
        role: "user",
        content,
      });
    } else if (msg.role === "assistant") {
      const am = msg as AssistantMessage;
      let content = "";
      let reasoningContent: string | undefined;
      const toolCalls: QoderToolCall[] = [];

      if (Array.isArray(am.content)) {
        for (const block of am.content) {
          if (block.type === "text") {
            content += (block as TextContent).text;
          } else if (block.type === "thinking") {
            reasoningContent = (reasoningContent ?? "") + (block as ThinkingContent).thinking;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            toolCalls.push({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
              },
            });
          }
        }
      } else {
        content = am.content || "";
      }

      const mapped: QoderMessage = {
        role: "assistant",
        content,
      };
      if (reasoningContent !== undefined) {
        mapped.reasoning_content = reasoningContent;
      }
      if (toolCalls.length > 0) {
        mapped.tool_calls = toolCalls;
      }
      normalizedMessages.push(mapped);
    } else if (msg.role === "toolResult") {
      const tr = msg as ToolResultMessage;
      normalizedMessages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: transformContentForQoder(tr),
      });
    }
  }

  return normalizedMessages;
}

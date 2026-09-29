import { describe, expect, it } from "vitest";
import { type DsmlToolCallDraft, DsmlToolCallParser } from "../dsml.js";

const command = `echo "quoted value" | cat; id`;
const invoke = `<｜｜DSML｜｜ invoke name="bash">
<｜｜DSML｜｜ parameter name="command" string="true">${command}</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="timeout" string="false">120</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`;
const markup = `<｜｜DSML｜｜ calls>\n${invoke}\n</｜｜DSML｜｜ calls>`;
const expectedCall = {
  id: "dsml_call_1",
  name: "bash",
  arguments: { command, timeout: 120 },
};

function parse(chunks: Iterable<string>) {
  let text = "";
  const calls: DsmlToolCallDraft[] = [];
  const parser = new DsmlToolCallParser({
    onText: (chunk) => {
      text += chunk;
    },
    onToolCall: (call) => calls.push(call),
  });
  for (const chunk of chunks) parser.processChunk(chunk);
  parser.finalize();
  return { text, calls };
}

const variants = ["｜", "｜｜"].flatMap((leading) =>
  ["｜", "｜｜"].flatMap((trailing) =>
    ["", " ", "\n"].flatMap((gap) =>
      ["calls", "function_calls", "tool_calls"].map((keyword) => ({ leading, trailing, gap, keyword })),
    ),
  ),
);

describe("DsmlToolCallParser", () => {
  it("extracts a whole call without altering shell syntax or parameter types", () => {
    expect(parse([markup])).toEqual({ text: "", calls: [expectedCall] });
    const stringNumber = markup.replace('name="timeout" string="false"', 'name="timeout" string="true"');
    expect(parse([stringNumber]).calls[0].arguments.timeout).toBe("120");
  });

  it.each(variants)("preserves chunk boundaries for $leading/$trailing/$gap/$keyword", (variant) => {
    const input = markup
      .replaceAll("｜｜DSML｜｜ ", `${variant.leading}DSML${variant.trailing}${variant.gap}`)
      .replaceAll("calls>", `${variant.keyword}>`);
    const expected = { text: "", calls: [expectedCall] };
    expect(parse([input])).toEqual(expected);
    expect(parse(input)).toEqual(expected);
  });

  it("extracts two invokes in order and preserves trailing prose", () => {
    const second = `<｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="path" string="true">/tmp/example</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`;
    const input = `Before\n<｜｜DSML｜｜ calls>${invoke}${second}</｜｜DSML｜｜ calls>\nAfter`;
    expect(parse(input)).toEqual({
      text: "Before\n\nAfter",
      calls: [expectedCall, { id: "dsml_call_2", name: "read", arguments: { path: "/tmp/example" } }],
    });
  });

  it("passes plain text and thinking tags through character by character", () => {
    const text = '中文 <thinking>reasoning</thinking>\n<think>x < y</think> "quoted" | <｜DS';
    expect(parse(text)).toEqual({ text, calls: [] });
  });

  it("accepts a single leading vertical bar", () => {
    expect(parse(markup.replaceAll("｜｜DSML", "｜DSML"))).toEqual({ text: "", calls: [expectedCall] });
  });

  it("salvages complete parameters when the invoke closing tag is missing", () => {
    const truncated = markup.slice(0, markup.indexOf("</｜｜DSML｜｜ invoke>"));
    expect(parse([truncated])).toEqual({ text: "", calls: [expectedCall] });
    expect(parse(truncated)).toEqual({ text: "", calls: [expectedCall] });
  });
});

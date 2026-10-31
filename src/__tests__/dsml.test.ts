import type { Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { recoverDsml } from "../dsml.js";

const tools = [
  {
    name: "probe",
    description: "Read fixture",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, flags: { type: "array", items: { type: "boolean" } } },
      required: ["key"],
      additionalProperties: false,
    },
  },
] as unknown as Tool[];
const invoke =
  '<｜DSML｜invoke name="probe"><｜DSML｜parameter name="key" string="true"> alpha\n</｜DSML｜parameter><｜DSML｜parameter name="flags" string="false">[true,false]</｜DSML｜parameter></｜DSML｜invoke>';

describe("DSML tool recovery", () => {
  it.each([
    "calls",
    "tool_calls",
    "function_calls",
  ])("recovers complete %s calls and preserves surrounding text", (wrapper) => {
    const result = recoverDsml(`Before\n<｜DSML｜${wrapper}>${invoke}</｜DSML｜${wrapper}>\nAfter`, tools);
    expect(result.kind).toBe("calls");
    if (result.kind !== "calls") throw new Error("Expected recovered calls");
    expect(result.content).toEqual([
      { type: "text", text: "Before\n" },
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_/),
        name: "probe",
        arguments: { key: " alpha\n", flags: [true, false] },
      },
      { type: "text", text: "\nAfter" },
    ]);
  });

  it("recovers missing wrappers and doubled-bar markers without guessing parameter types", () => {
    const raw = invoke.replaceAll("｜DSML｜", "｜｜DSML｜｜ ");
    const result = recoverDsml(raw, tools);
    expect(result.kind).toBe("calls");
    if (result.kind !== "calls") throw new Error("Expected recovered calls");
    expect(result.content[0]).toMatchObject({ name: "probe", arguments: { key: " alpha\n", flags: [true, false] } });
  });

  it.each([
    invoke.replace('name="probe"', 'name="unknown"'),
    invoke.replace('name="key"', 'name="wrong"'),
    invoke.replace("[true,false]", '["false"]'),
    invoke.replace("[true,false]", "not-json"),
    invoke.replace('name="flags"', 'name="key"'),
    invoke.replace('name="key"', 'name="__proto__"'),
    invoke.replace('string="true"', 'string="sometimes"'),
    invoke.slice(0, -10),
    `<｜DSML｜tool_calls>${invoke}`,
    `</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`,
    `<｜DSML｜tool_calls>${invoke}${invoke.replace('name="probe"', 'name="unknown"')}</｜DSML｜tool_calls>`,
  ])("rejects malformed or schema-invalid calls atomically: %s", (text) => {
    expect(recoverDsml(text, tools).kind).toBe("malformed");
  });

  it.each([
    `\`\`\`xml\n${invoke}\n\`\`\``,
    `~~~~xml\n${invoke}\n~~~\n${invoke}`, // A shorter fence cannot close the longer one.
    `> ${invoke}`,
    `Protocol example: \`${invoke}\``,
    "The marker <｜DSML｜tool_calls> is used by DeepSeek.",
    "<｜｜DSML｜｜ calls>",
    "<｜DSML",
  ])("keeps examples and isolated markers literal: %s", (text) => {
    expect(recoverDsml(text, tools)).toEqual({ kind: "text" });
  });

  it("never recovers tools that are not offered on this request", () => {
    expect(recoverDsml(invoke, [])).toEqual({ kind: "text" });
  });
});

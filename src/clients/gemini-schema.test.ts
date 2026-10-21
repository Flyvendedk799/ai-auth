import { describe, it, expect } from "vitest";
import { sanitizeGeminiFunctionParameters as clean } from "./gemini-schema.js";
import { toCodeAssistRequest } from "./options.js";

describe("Gemini tool schema conversion", () => {
  it("normalizes deeply nested nullable type arrays without mutating the original", () => {
    const schema = {
      type: "object",
      properties: {
        definition: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: { projectId: { type: ["string", "null"] } },
                required: ["projectId"],
              },
            },
          },
        },
      },
    };
    const before = JSON.stringify(schema);
    const result = clean(schema) as any;
    expect(
      result.properties.definition.properties.steps.items.properties.projectId,
    ).toEqual({ type: "string", nullable: true });
    expect(
      result.properties.definition.properties.steps.items.required,
    ).toEqual(["projectId"]);
    expect(JSON.stringify(schema)).toBe(before);
  });
  it("keeps multiple non-null alternatives rather than picking one", () => {
    expect(
      clean({ type: ["string", "number", "null"], description: "value" }),
    ).toEqual({
      description: "value",
      nullable: true,
      anyOf: [
        { type: "string", nullable: true, description: "value" },
        { type: "number", nullable: true, description: "value" },
      ],
    });
  });
  it("visits anyOf children but preserves property names and literal defaults", () => {
    const literal = {
      type: ["this", "is", "data"],
      additionalProperties: "also data",
    };
    expect(
      clean({
        type: "object",
        properties: {
          type: { type: ["string", "null"] },
          additionalProperties: {
            anyOf: [{ type: ["number", "null"] }, { type: "boolean" }],
          },
        },
        default: literal,
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        type: { type: "string", nullable: true },
        additionalProperties: {
          anyOf: [{ type: "number", nullable: true }, { type: "boolean" }],
        },
      },
      default: literal,
    });
  });
  it("does not discard existing anyOf restrictions on a type union", () => {
    const result = clean({
      type: ["string", "number"],
      anyOf: [
        { type: "string", enum: ["a"] },
        { type: "number", minimum: 3 },
      ],
    }) as any;
    expect(result.anyOf[0].anyOf).toHaveLength(2);
  });
  it("normalizes at the shared wire boundary and keeps parameterless tools parameterless", () => {
    const body = toCodeAssistRequest("gemini-3.1-pro", "hello", {
      tools: [
        {
          name: "plan",
          parameters: {
            type: "object",
            properties: { projectId: { type: ["null", "string"] } },
          },
        },
        { name: "ping" },
      ],
    });
    expect(
      body.request.tools?.[0].functionDeclarations[0].parameters.properties
        .projectId,
    ).toEqual({ type: "string", nullable: true });
    expect(body.request.tools?.[0].functionDeclarations[1]).not.toHaveProperty(
      "parameters",
    );
  });

  it("keeps literal values: const becomes a one-value enum", () => {
    expect(clean({ type: "string", const: "wasd" })).toEqual({
      type: "string",
      enum: ["wasd"],
    });
  });

  it("collapses a union of literals into one enum instead of an unconstrained anyOf", () => {
    const schema = {
      type: "object",
      properties: {
        controlScheme: {
          anyOf: [
            { type: "string", const: "wasd" },
            { type: "string", const: "arrows" },
          ],
        },
      },
    };
    expect((clean(schema) as any).properties.controlScheme).toEqual({
      type: "string",
      enum: ["wasd", "arrows"],
    });
  });

  it("leaves a non-literal anyOf alone", () => {
    const out = clean({
      anyOf: [{ type: "string" }, { type: "number" }],
    }) as any;
    expect(out.anyOf).toHaveLength(2);
  });
});

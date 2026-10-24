/**
 * Convert JSON Schema tool parameters to Gemini's Schema message. In particular,
 * Schema.type is a scalar enum, not JSON Schema's array of allowed types.
 * Only visit schema positions: a property named `type` is still a user property.
 * The caller's schema remains untouched for other providers and tool validation.
 */
const KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "nullable",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "title",
  "default",
  "anyOf",
  "minProperties",
  "maxProperties",
  "propertyOrdering",
  "example",
]);

export function sanitizeGeminiFunctionParameters(
  schema: unknown,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    // Gemini has no `const`. A literal is a one-value enum, and dropping it instead leaves the
    // model with a bare `{ type: "string" }` that accepts (and invents) any value.
    if (key === "const") {
      if (!Array.isArray(src.enum)) out.enum = [value];
      continue;
    }
    if (!KEYS.has(key)) continue;
    if (
      key === "properties" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          sanitizeGeminiFunctionParameters(child),
        ]),
      );
    } else if (key === "items") {
      out.items = sanitizeGeminiFunctionParameters(value);
    } else if (key === "anyOf" && Array.isArray(value)) {
      const branches = value.map(sanitizeGeminiFunctionParameters);
      const merged = mergeLiteralUnion(branches);
      if (merged) Object.assign(out, merged);
      else out.anyOf = branches;
    } else {
      out[key] = value;
    }
  }
  if (Array.isArray(src.type)) {
    const types = [
      ...new Set(src.type.filter((t): t is string => typeof t === "string")),
    ];
    const nonNull = types.filter((t) => t.toLowerCase() !== "null");
    if (nonNull.length !== types.length) out.nullable = true;
    if (nonNull.length === 1) out.type = nonNull[0];
    else if (nonNull.length > 1) {
      delete out.type;
      // Keep every alternative, rather than silently selecting the first type.
      const common = { ...out };
      out.anyOf = nonNull.map((type) => ({ ...common, type }));
    } else out.type = "null";
  }
  if (!out.type && !out.anyOf && (out.properties || out.required))
    out.type = "object";
  // Gemini's Schema.enum is repeated *string*: a numeric/boolean literal is rejected with a 400
  // (`enum[0] (TYPE_STRING), 1`). Drop the constraint, keep the scalar type, and say the allowed
  // values in the description so the model still sees them.
  if (Array.isArray(out.enum) && out.enum.some((v) => typeof v !== "string")) {
    const allowed = out.enum as unknown[];
    delete out.enum;
    const note = `Allowed value(s): ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
    out.description =
      typeof out.description === "string" ? `${out.description} ${note}` : note;
    if (!out.type) {
      out.type = allowed.every((v) => typeof v === "boolean")
        ? "boolean"
        : allowed.every((v) => typeof v === "number")
          ? Number.isInteger(allowed[0])
            ? "integer"
            : "number"
          : "string";
    }
  }
  return out;
}

/**
 * `Type.Union([Type.Literal("a"), Type.Literal("b")])` arrives as `anyOf` of single-value enums.
 * Gemini handles that badly (and a union of literals is just an enum), so collapse it:
 * `{ type, enum: ["a", "b"] }`. Returns null when the branches are anything else.
 */
function mergeLiteralUnion(
  branches: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (branches.length === 0) return null;
  const values: unknown[] = [];
  let type: unknown;
  for (const b of branches) {
    if (!Array.isArray(b.enum) || b.anyOf) return null;
    if (type !== undefined && b.type !== type) return null;
    type = b.type;
    values.push(...b.enum);
  }
  return { ...(type !== undefined ? { type } : {}), enum: [...new Set(values)] };
}

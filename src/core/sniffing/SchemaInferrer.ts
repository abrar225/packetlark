export interface JsonSchemaProperty {
  type?: string | string[];
  anyOf?: JsonSchemaProperty[];
  format?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  nullable?: boolean;
  example?: any;
}

export class SchemaInferrer {
  /**
   * Infers an OpenAPI 3.1 compatible JSON Schema from any JS value.
   */
  public static infer(value: any): JsonSchemaProperty {
    if (value === null || value === undefined) {
      return { type: "null" };
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return { type: "array", items: {} };
      }
      // Infer item schema from array elements and merge
      let mergedItemSchema: JsonSchemaProperty = this.infer(value[0]);
      for (let i = 1; i < value.length; i++) {
        mergedItemSchema = this.mergeSchemas(
          mergedItemSchema,
          this.infer(value[i]),
        );
      }
      return {
        type: "array",
        items: mergedItemSchema,
      };
    }

    const valType = typeof value;

    if (valType === "boolean") {
      return { type: "boolean", example: value };
    }

    if (valType === "number") {
      const isInteger = Number.isInteger(value);
      return {
        type: isInteger ? "integer" : "number",
        format: isInteger ? "int64" : "double",
        example: value,
      };
    }

    if (valType === "string") {
      const format = this.detectStringFormat(value);
      return {
        type: "string",
        format,
        example: value,
      };
    }

    if (valType === "object") {
      const properties: Record<string, JsonSchemaProperty> =
        Object.create(null);
      const required: string[] = [];

      for (const [key, val] of Object.entries(value)) {
        properties[key] = this.infer(val);
        if (val !== undefined) {
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }

    return { type: "string" };
  }

  /**
   * Merges two JSON schemas (e.g. from multiple captured response samples).
   */
  public static mergeSchemas(
    schemaA: JsonSchemaProperty,
    schemaB: JsonSchemaProperty,
  ): JsonSchemaProperty {
    if (!schemaA.type && !schemaA.anyOf) return schemaB;
    if (!schemaB.type && !schemaB.anyOf) return schemaA;
    if (schemaA.type === "null" && schemaB.type)
      return {
        ...schemaB,
        type: [...new Set([].concat(schemaB.type as any, "null"))],
      };
    if (schemaB.type === "null" && schemaA.type)
      return {
        ...schemaA,
        type: [...new Set([].concat(schemaA.type as any, "null"))],
      };
    if (
      [schemaA.type, schemaB.type].every(
        (type) => type === "integer" || type === "number",
      )
    )
      return { type: schemaA.type === schemaB.type ? schemaA.type : "number" };
    if (schemaA.type === "object" && schemaB.type === "object") {
      const mergedProps: Record<string, JsonSchemaProperty> = {
        ...(schemaA.properties || {}),
      };

      for (const [k, v] of Object.entries(schemaB.properties || {})) {
        if (mergedProps[k]) {
          mergedProps[k] = this.mergeSchemas(mergedProps[k], v);
        } else {
          mergedProps[k] = v;
        }
      }

      // Intersection of required fields
      const reqA = new Set(schemaA.required || []);
      const reqB = new Set(schemaB.required || []);
      const commonReq = [...reqA].filter((x) => reqB.has(x));

      return {
        type: "object",
        properties: mergedProps,
        required: commonReq.length > 0 ? commonReq : undefined,
      };
    }

    if (schemaA.type === "array" && schemaB.type === "array") {
      return {
        type: "array",
        items: this.mergeSchemas(
          schemaA.items || { type: "string" },
          schemaB.items || { type: "string" },
        ),
      };
    }

    if (
      JSON.stringify(schemaA.type) !== JSON.stringify(schemaB.type) ||
      schemaA.anyOf ||
      schemaB.anyOf
    ) {
      const variants = [
        ...(schemaA.anyOf || [schemaA]),
        ...(schemaB.anyOf || [schemaB]),
      ];
      return {
        anyOf: [
          ...new Map(variants.map((s) => [JSON.stringify(s), s])).values(),
        ],
      };
    }
    if (schemaA.format !== schemaB.format) {
      const result = { ...schemaA };
      delete result.format;
      return result;
    }

    return schemaA;
  }

  private static detectStringFormat(str: string): string | undefined {
    // ISO Date-time
    if (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        str,
      )
    ) {
      return "date-time";
    }
    // Date only
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return "date";
    }
    // UUID
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        str,
      )
    ) {
      return "uuid";
    }
    // Email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
      return "email";
    }
    // URL / URI
    if (/^https?:\/\/\S+$/i.test(str)) {
      return "uri";
    }
    // IPv4
    if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(str)) {
      return "ipv4";
    }
    return undefined;
  }
}

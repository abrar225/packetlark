export interface JsonSchemaProperty {
  type: string | string[];
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
      return { type: 'null' };
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return { type: 'array', items: { type: 'string' } };
      }
      // Infer item schema from array elements and merge
      let mergedItemSchema: JsonSchemaProperty = this.infer(value[0]);
      for (let i = 1; i < Math.min(value.length, 10); i++) {
        mergedItemSchema = this.mergeSchemas(mergedItemSchema, this.infer(value[i]));
      }
      return {
        type: 'array',
        items: mergedItemSchema
      };
    }

    const valType = typeof value;

    if (valType === 'boolean') {
      return { type: 'boolean', example: value };
    }

    if (valType === 'number') {
      const isInteger = Number.isInteger(value);
      return {
        type: isInteger ? 'integer' : 'number',
        format: isInteger ? 'int64' : 'double',
        example: value
      };
    }

    if (valType === 'string') {
      const format = this.detectStringFormat(value);
      return {
        type: 'string',
        format,
        example: value.length > 50 ? value.substring(0, 47) + '...' : value
      };
    }

    if (valType === 'object') {
      const properties: Record<string, JsonSchemaProperty> = {};
      const required: string[] = [];

      for (const [key, val] of Object.entries(value)) {
        properties[key] = this.infer(val);
        if (val !== null && val !== undefined) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined
      };
    }

    return { type: 'string' };
  }

  /**
   * Merges two JSON schemas (e.g. from multiple captured response samples).
   */
  public static mergeSchemas(schemaA: JsonSchemaProperty, schemaB: JsonSchemaProperty): JsonSchemaProperty {
    if (schemaA.type === 'null') {
      return { ...schemaB, nullable: true };
    }
    if (schemaB.type === 'null') {
      return { ...schemaA, nullable: true };
    }

    if (schemaA.type === 'object' && schemaB.type === 'object') {
      const mergedProps: Record<string, JsonSchemaProperty> = { ...(schemaA.properties || {}) };

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
      const commonReq = [...reqA].filter(x => reqB.has(x));

      return {
        type: 'object',
        properties: mergedProps,
        required: commonReq.length > 0 ? commonReq : undefined
      };
    }

    if (schemaA.type === 'array' && schemaB.type === 'array') {
      return {
        type: 'array',
        items: this.mergeSchemas(schemaA.items || { type: 'string' }, schemaB.items || { type: 'string' })
      };
    }

    if (schemaA.type !== schemaB.type) {
      const types = Array.isArray(schemaA.type) ? schemaA.type : [schemaA.type];
      const newType = Array.isArray(schemaB.type) ? schemaB.type : [schemaB.type];
      return {
        type: Array.from(new Set([...types, ...newType]))
      };
    }

    return schemaA;
  }

  private static detectStringFormat(str: string): string | undefined {
    // ISO Date-time
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(str)) {
      return 'date-time';
    }
    // Date only
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      return 'date';
    }
    // UUID
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
      return 'uuid';
    }
    // Email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
      return 'email';
    }
    // URL / URI
    if (/^https?:\/\/\S+$/i.test(str)) {
      return 'uri';
    }
    // IPv4
    if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(str)) {
      return 'ipv4';
    }
    return undefined;
  }
}

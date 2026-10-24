export class SdkGenerator {
  /**
   * Converts kebab-case, snake_case, dot.case, and other non-alphanumeric identifiers
   * to a clean, valid TypeScript camelCase method name.
   */
  public static sanitizeMethodName(raw: string): string {
    const parts = raw.split(/[-_.\s]+/).filter(Boolean);
    if (parts.length === 0) return 'request';

    let name = parts[0].toLowerCase();
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      name += part.charAt(0).toUpperCase() + part.slice(1);
    }

    // If starts with a digit, prefix with req
    if (/^[0-9]/.test(name)) {
      name = 'req' + name;
    }

    return name.replace(/[^a-zA-Z0-9]/g, '') || 'request';
  }

  /**
   * Recursively converts a JSON Schema to a TypeScript type or interface string.
   */
  private static schemaToTypeScriptType(schema: any, indent = 0): string {
    if (!schema) return 'any';
    if (schema.type === 'string') {
      if (schema.enum && Array.isArray(schema.enum)) {
        return schema.enum.map((e: string) => JSON.stringify(e)).join(' | ');
      }
      return 'string';
    }
    if (schema.type === 'number' || schema.type === 'integer') return 'number';
    if (schema.type === 'boolean') return 'boolean';
    if (schema.type === 'array') {
      const itemType = this.schemaToTypeScriptType(schema.items, indent);
      return `${itemType}[]`;
    }
    if (schema.type === 'object' && schema.properties) {
      const spaces = ' '.repeat(indent);
      const innerSpaces = ' '.repeat(indent + 2);
      const props: string[] = [];
      const required = Array.isArray(schema.required) ? schema.required : [];

      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        const isReq = required.includes(propName);
        const safeProp = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(propName) ? propName : JSON.stringify(propName);
        const propType = this.schemaToTypeScriptType(propSchema, indent + 2);
        props.push(`${innerSpaces}${safeProp}${isReq ? '' : '?'}: ${propType};`);
      }

      return `{\n${props.join('\n')}\n${spaces}}`;
    }
    return 'any';
  }

  /**
   * Generates a strongly typed TypeScript Client SDK from an OpenAPI 3.1 specification.
   */
  public static generateTypeScript(openApiSpec: any): string {
    const title = (openApiSpec.info?.title || 'ApiClient').replace(/[^a-zA-Z0-9]/g, '') || 'ApiClient';
    const serverUrl = openApiSpec.servers?.[0]?.url || 'http://localhost';

    const generatedInterfacesMap = new Map<string, string>();

    const registerInterface = (suggestedName: string, schema: any): string => {
      const ifaceBody = this.schemaToTypeScriptType(schema, 0);
      let finalName = suggestedName;
      let counter = 1;
      while (generatedInterfacesMap.has(finalName)) {
        if (generatedInterfacesMap.get(finalName) === ifaceBody) {
          return finalName; // Identical interface, safely reuse
        }
        counter++;
        finalName = `${suggestedName}${counter}`;
      }
      generatedInterfacesMap.set(finalName, ifaceBody);
      return finalName;
    };

    // First pass: generate interfaces for request and response payloads
    const operationsList: Array<{
      method: string;
      pathStr: string;
      op: any;
      methodName: string;
      requestTypeName: string;
      responseTypeName: string;
      hasBody: boolean;
      pathParams: any[];
      queryParams: any[];
    }> = [];

    for (const [pathStr, pathItem] of Object.entries(openApiSpec.paths || {})) {
      for (const [method, op] of Object.entries(pathItem as Record<string, any>)) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) {
          const rawId = op.operationId || `${method}_${pathStr.replace(/[^a-zA-Z0-9]/g, '_')}`;
          const methodName = this.sanitizeMethodName(rawId);
          const baseName = methodName.charAt(0).toUpperCase() + methodName.slice(1);

          const pathParams = (op.parameters || []).filter((p: any) => p.in === 'path');
          const queryParams = (op.parameters || []).filter((p: any) => p.in === 'query');

          // Request body schema
          const bodyContent = op.requestBody?.content?.['application/json'];
          const hasBody = Boolean(bodyContent?.schema);
          let requestTypeName = 'any';
          if (hasBody) {
            requestTypeName = registerInterface(`${baseName}Request`, bodyContent.schema);
          }

          // Response schema (prefer 200 or 201)
          const okResponse = op.responses?.['200'] || op.responses?.['201'] || Object.values(op.responses || {})[0];
          const resContent = (okResponse as any)?.content?.['application/json'];
          const hasResSchema = Boolean(resContent?.schema);
          let responseTypeName = 'any';
          if (hasResSchema) {
            responseTypeName = registerInterface(`${baseName}Response`, resContent.schema);
          }

          operationsList.push({
            method,
            pathStr,
            op,
            methodName,
            requestTypeName,
            responseTypeName,
            hasBody,
            pathParams,
            queryParams
          });
        }
      }
    }

    const generatedInterfaces = Array.from(generatedInterfacesMap.entries()).map(
      ([name, body]) => `export interface ${name} ${body}`
    );

    let code = `/**
 * Auto-generated Client SDK for ${openApiSpec.info?.title || 'API'}
 * Generated by ReaAPI Studio
 */

export interface RequestOptions {
  headers?: Record<string, string>;
  token?: string;
}

${generatedInterfaces.length > 0 ? generatedInterfaces.join('\n\n') + '\n\n' : ''}export class ${title} {
  private baseUrl: string;

  constructor(baseUrl: string = '${serverUrl}') {
    this.baseUrl = baseUrl.replace(/\\/+$/, '');
  }

  private async request<T>(path: string, options: RequestInit & { token?: string }): Promise<T> {
    const url = \`\${this.baseUrl}\${path}\`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {})
    };

    if (options.token) {
      headers['Authorization'] = \`Bearer \${options.token}\`;
    }

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(\`HTTP \${res.status} \${res.statusText}: \${errBody}\`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json() as Promise<T>;
    }
    return (await res.text()) as unknown as T;
  }
`;

    // Generate methods for each operation
    for (const item of operationsList) {
      const {
        method,
        pathStr,
        op,
        methodName,
        requestTypeName,
        responseTypeName,
        hasBody,
        pathParams,
        queryParams
      } = item;

      const paramArgs: string[] = [];
      for (const p of pathParams) {
        paramArgs.push(`${p.name}: string | number`);
      }
      if (hasBody) {
        paramArgs.push(`body: ${requestTypeName}`);
      }
      if (queryParams.length > 0) {
        paramArgs.push(`query?: Record<string, any>`);
      }
      paramArgs.push('options?: RequestOptions');

      let pathTemplate = pathStr;
      for (const p of pathParams) {
        pathTemplate = pathTemplate.replaceAll(`{${p.name}}`, `\${${p.name}}`);
      }

      code += `
  /**
   * ${op.summary || `${method.toUpperCase()} ${pathStr}`}
   */
  public async ${methodName}(${paramArgs.join(', ')}): Promise<${responseTypeName}> {
    let path = \`${pathTemplate}\`;
    ${
      queryParams.length > 0
        ? `
    if (query && Object.keys(query).length > 0) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) sp.append(k, String(v));
      }
      path += \`?\${sp.toString()}\`;
    }`
        : ''
    }

    return this.request<${responseTypeName}>(path, {
      method: '${method.toUpperCase()}',
      ${hasBody ? 'body: JSON.stringify(body),' : ''}
      headers: options?.headers,
      token: options?.token
    });
  }
`;
    }

    code += `}\n`;
    return code;
  }
}

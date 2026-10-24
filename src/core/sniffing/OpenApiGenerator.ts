import { SniffedTrafficItem } from '../models/types.js';
import { SchemaInferrer } from './SchemaInferrer.js';

export class OpenApiGenerator {
  /**
   * Generates a complete OpenAPI 3.1.0 specification from captured traffic records.
   */
  public static generate(
    trafficItems: SniffedTrafficItem[],
    apiTitle: string = 'Reverse-Engineered API',
    apiVersion: string = '1.0.0'
  ): any {
    const pathsObj: Record<string, any> = {};
    const serversSet = new Set<string>();

    for (const item of trafficItems) {
      try {
        const urlObj = new URL(item.url);
        serversSet.add(`${urlObj.protocol}//${urlObj.host}`);

        // Normalize path segments (e.g. numeric IDs or UUIDs become parameters)
        const { normalizedPath, pathParams } = this.normalizePath(urlObj.pathname);

        if (!pathsObj[normalizedPath]) {
          pathsObj[normalizedPath] = {};
        }

        const method = item.method.toLowerCase();
        if (!pathsObj[normalizedPath][method]) {
          pathsObj[normalizedPath][method] = {
            summary: `${item.method} ${normalizedPath}`,
            operationId: `${method}_${normalizedPath.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '')}`,
            tags: [this.extractTag(normalizedPath)],
            parameters: [],
            responses: {}
          };
        }

        const operation = pathsObj[normalizedPath][method];

        // 1. Path parameters
        for (const p of pathParams) {
          if (!operation.parameters.some((param: any) => param.name === p && param.in === 'path')) {
            operation.parameters.push({
              name: p,
              in: 'path',
              required: true,
              schema: { type: 'string' }
            });
          }
        }

        // 2. Query parameters
        for (const [qKey, qVal] of Object.entries(item.queryParams || {})) {
          if (!operation.parameters.some((param: any) => param.name === qKey && param.in === 'query')) {
            operation.parameters.push({
              name: qKey,
              in: 'query',
              required: false,
              schema: SchemaInferrer.infer(qVal)
            });
          }
        }

        // 3. Request body
        if (item.requestBody && method !== 'get' && method !== 'head') {
          const bodySchema = SchemaInferrer.infer(item.requestBody);
          if (!operation.requestBody) {
            operation.requestBody = {
              required: true,
              content: {
                'application/json': {
                  schema: bodySchema
                }
              }
            };
          } else if (operation.requestBody.content?.['application/json']) {
            operation.requestBody.content['application/json'].schema = SchemaInferrer.mergeSchemas(
              operation.requestBody.content['application/json'].schema,
              bodySchema
            );
          }
        }

        // 4. Response
        const statusCode = item.responseStatus ? String(item.responseStatus) : '200';
        if (!operation.responses[statusCode]) {
          operation.responses[statusCode] = {
            description: `Status ${statusCode} Response`,
            content: {}
          };
        }

        if (item.responseBody) {
          const resSchema = SchemaInferrer.infer(item.responseBody);
          if (!operation.responses[statusCode].content['application/json']) {
            operation.responses[statusCode].content['application/json'] = {
              schema: resSchema
            };
          } else {
            operation.responses[statusCode].content['application/json'].schema = SchemaInferrer.mergeSchemas(
              operation.responses[statusCode].content['application/json'].schema,
              resSchema
            );
          }
        }
      } catch (err) {
        // Skip invalid URL
      }
    }

    return {
      openapi: '3.1.0',
      info: {
        title: apiTitle,
        version: apiVersion,
        description: 'Auto-generated specification reverse-engineered from live HTTP traffic via ReaAPI Studio.'
      },
      servers: Array.from(serversSet).map(s => ({ url: s })),
      paths: pathsObj
    };
  }

  private static normalizePath(pathname: string): { normalizedPath: string; pathParams: string[] } {
    const segments = pathname.split('/').filter(Boolean);
    const pathParams: string[] = [];
    const usedNames = new Map<string, number>();

    const normalizedSegments = segments.map((seg, idx) => {
      let isParam = false;

      // 1. Numeric ID: e.g. 12345
      if (/^\d+$/.test(seg)) {
        isParam = true;
      }
      // 2. UUID: e.g. 123e4567-e89b-12d3-a456-426614174000
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
        isParam = true;
      }
      // 3. MongoDB ObjectId (24 hex characters): e.g. 507f1f77bcf86cd799439011
      else if (/^[0-9a-fA-F]{24}$/.test(seg)) {
        isParam = true;
      }
      // 4. Prefixed IDs (Stripe, Clerk, Supabase, etc.): e.g. cus_123, sub_abc, user_xyz
      else if (/^[a-zA-Z]{2,8}_[a-zA-Z0-9]{4,}$/.test(seg)) {
        isParam = true;
      }
      // 5. Hex Hashes (MD5: 32, SHA1: 40, SHA256: 64)
      else if (/^[0-9a-fA-F]{32,64}$/.test(seg)) {
        isParam = true;
      }

      if (isParam) {
        let singular = idx > 0 ? segments[idx - 1] : 'id';
        if (singular.endsWith('ies') && singular.length > 3) {
          singular = singular.slice(0, -3) + 'y';
        } else if (singular.endsWith('us') || singular.endsWith('ss') || singular.endsWith('is')) {
          // Keep singular nouns ending in us (status), ss (address, access), is (basis)
        } else if (singular.endsWith('zzes')) {
          singular = singular.slice(0, -3);
        } else if (/(?:sses|xes|ches|shes)$/i.test(singular)) {
          singular = singular.slice(0, -2);
        } else if (singular.endsWith('s') && !singular.endsWith('ss')) {
          singular = singular.slice(0, -1);
        }
        let baseName = idx > 0 ? `${singular.replace(/[^a-zA-Z0-9]/g, '')}Id` : 'id';
        if (!baseName || baseName === 'Id') baseName = 'id';

        let finalName = baseName;
        const count = usedNames.get(baseName) || 0;
        if (count > 0) {
          finalName = `${baseName}${count + 1}`;
        }
        usedNames.set(baseName, count + 1);
        pathParams.push(finalName);
        return `{${finalName}}`;
      }

      return seg;
    });

    return {
      normalizedPath: '/' + normalizedSegments.join('/'),
      pathParams
    };
  }

  private static extractTag(pathname: string): string {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return 'default';
    if (segments[0] === 'api' && segments.length > 1) {
      if (/^v\d+$/i.test(segments[1]) && segments.length > 2) {
        return segments[2];
      }
      return segments[1];
    }
    return segments[0];
  }
}

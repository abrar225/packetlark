import { describe, it, expect } from 'vitest';
import { SchemaInferrer } from '../src/core/sniffing/SchemaInferrer.js';
import { OpenApiGenerator } from '../src/core/sniffing/OpenApiGenerator.js';
import { SdkGenerator } from '../src/core/sniffing/SdkGenerator.js';
import { SniffedTrafficItem } from '../src/core/models/types.js';

describe('OpenApiGenerator & SchemaInferrer', () => {
  it('infers data types, dates, uuids, and nested schemas', () => {
    const payload = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      username: 'johndoe',
      age: 30,
      createdAt: '2026-10-24T12:00:00Z',
      active: true,
      roles: ['admin', 'editor']
    };

    const schema = SchemaInferrer.infer(payload);
    expect(schema.type).toBe('object');
    expect(schema.properties?.id.format).toBe('uuid');
    expect(schema.properties?.age.type).toBe('integer');
    expect(schema.properties?.createdAt.format).toBe('date-time');
    expect(schema.properties?.active.type).toBe('boolean');
    expect(schema.properties?.roles.type).toBe('array');
  });

  it('generates OpenAPI 3.1.0 document from captured traffic records', () => {
    const traffic: SniffedTrafficItem[] = [
      {
        id: '1',
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: 'https://api.myapp.com/api/v1/users/101',
        pathname: '/api/v1/users/101',
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: { id: 101, name: 'Alice' },
        durationMs: 14
      },
      {
        id: '2',
        timestamp: new Date().toISOString(),
        method: 'POST',
        url: 'https://api.myapp.com/api/v1/users',
        pathname: '/api/v1/users',
        queryParams: {},
        requestHeaders: { 'content-type': 'application/json' },
        requestBody: { name: 'Bob', email: 'bob@example.com' },
        responseStatus: 201,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: { id: 102, name: 'Bob', created: true },
        durationMs: 22
      }
    ];

    const spec = OpenApiGenerator.generate(traffic, 'My Test API', '2.0.0');
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('My Test API');

    // Should parameterize /api/v1/users/101 -> /api/v1/users/{userId}
    expect(spec.paths['/api/v1/users/{userId}']).toBeDefined();
    expect(spec.paths['/api/v1/users/{userId}'].get).toBeDefined();

    expect(spec.paths['/api/v1/users']).toBeDefined();
    expect(spec.paths['/api/v1/users'].post).toBeDefined();
    expect(spec.paths['/api/v1/users'].post.requestBody.content['application/json']).toBeDefined();
  });

  it('parameterizes MongoDB ObjectIds (24-hex characters)', () => {
    const traffic: SniffedTrafficItem[] = [
      {
        id: 'mongo-1',
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: 'https://api.myapp.com/api/v1/articles/507f1f77bcf86cd799439011',
        pathname: '/api/v1/articles/507f1f77bcf86cd799439011',
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: {},
        responseBody: { title: 'Deep Analysis' },
        durationMs: 10
      }
    ];

    const spec = OpenApiGenerator.generate(traffic);
    expect(spec.paths['/api/v1/articles/{articleId}']).toBeDefined();
    expect(spec.paths['/api/v1/articles/{articleId}'].get.parameters[0].name).toBe('articleId');
  });

  it('parameterizes Stripe IDs and deduplicates identical param names across path', () => {
    const traffic: SniffedTrafficItem[] = [
      {
        id: 'stripe-1',
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: 'https://api.stripe.com/v1/customers/cus_9s6XKzkCOSpDuI/subscriptions/sub_49x11c18605',
        pathname: '/v1/customers/cus_9s6XKzkCOSpDuI/subscriptions/sub_49x11c18605',
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: {},
        responseBody: { active: true },
        durationMs: 15
      },
      {
        id: 'dedup-1',
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: 'https://api.myapp.com/items/1/items/2',
        pathname: '/items/1/items/2',
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: {},
        durationMs: 5
      }
    ];

    const spec = OpenApiGenerator.generate(traffic);
    expect(spec.paths['/v1/customers/{customerId}/subscriptions/{subscriptionId}']).toBeDefined();
    expect(spec.paths['/items/{itemId}/items/{itemId2}']).toBeDefined();
  });

  it('sanitizes method names to valid camelCase identifiers and generates typed SDK interfaces', () => {
    expect(SdkGenerator.sanitizeMethodName('get-user-by-id')).toBe('getUserById');
    expect(SdkGenerator.sanitizeMethodName('post_api_v1_orders')).toBe('postApiV1Orders');
    expect(SdkGenerator.sanitizeMethodName('delete.account.v2')).toBe('deleteAccountV2');
    expect(SdkGenerator.sanitizeMethodName('123action')).toBe('req123action');

    const sampleSpec = {
      openapi: '3.1.0',
      info: { title: 'Inventory Service' },
      servers: [{ url: 'https://inventory.local' }],
      paths: {
        '/items': {
          post: {
            operationId: 'create-new-item',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { sku: { type: 'string' }, price: { type: 'number' } },
                    required: ['sku']
                  }
                }
              }
            },
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'number' }, success: { type: 'boolean' } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const sdk = SdkGenerator.generateTypeScript(sampleSpec);
    expect(sdk).toContain('export class InventoryService');
    expect(sdk).toContain('export interface CreateNewItemRequest');
    expect(sdk).toContain('sku: string;');
    expect(sdk).toContain('price?: number;');
    expect(sdk).toContain('export interface CreateNewItemResponse');
    expect(sdk).toContain('public async createNewItem(');
  });

  it('accurately singularizes words ending in ss, ies, and es without corruption', () => {
    const traffic: SniffedTrafficItem[] = [
      {
        id: '1',
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: 'https://api.example.com/addresses/12345',
        pathname: '/addresses/12345',
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: {},
        durationMs: 5
      },
      {
        id: '2',
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: 'https://api.example.com/categories/67890',
        pathname: '/categories/67890',
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: {},
        durationMs: 5
      },
      {
        id: '3',
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: 'https://api.example.com/status/999',
        pathname: '/status/999',
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: {},
        durationMs: 5
      },
      {
        id: '4',
        timestamp: new Date().toISOString(),
        method: 'GET',
        url: 'https://api.example.com/orgs/org_test12345',
        pathname: '/orgs/org_test12345',
        queryParams: {},
        requestHeaders: {},
        responseStatus: 200,
        responseHeaders: {},
        durationMs: 5
      }
    ];

    const spec = OpenApiGenerator.generate(traffic);
    expect(spec.paths['/addresses/{addressId}']).toBeDefined();
    expect(spec.paths['/categories/{categoryId}']).toBeDefined();
    expect(spec.paths['/status/{statusId}']).toBeDefined();
    expect(spec.paths['/orgs/{orgId}']).toBeDefined();
  });

  it('deduplicates identical interface types across operations in SdkGenerator without naming conflicts', () => {
    const multiSpec = {
      openapi: '3.1.0',
      info: { title: 'Order Service' },
      servers: [{ url: 'https://orders.local' }],
      paths: {
        '/orders': {
          get: {
            operationId: 'get_orders',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { count: { type: 'number' } } }
                  }
                }
              }
            }
          },
          post: {
            operationId: 'create_order',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { count: { type: 'number' } } }
                }
              }
            },
            responses: {
              '201': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { count: { type: 'number' } } }
                  }
                }
              }
            }
          }
        }
      }
    };

    const sdk = SdkGenerator.generateTypeScript(multiSpec);
    // Should compile without syntax or duplicate identifier errors
    const matchCount = (sdk.match(/export interface GetOrdersResponse/g) || []).length;
    expect(matchCount).toBe(1);
    expect(sdk).toContain('public async getOrders(');
    expect(sdk).toContain('public async createOrder(');
  });
});

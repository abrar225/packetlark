import vm from 'node:vm';
import { TestAssertionResult } from '../models/types.js';

export interface SandboxExecutionResult {
  updatedVariables: Record<string, string>;
  testResults: TestAssertionResult[];
  logs: string[];
}

function createSecureError(message: string): Error {
  const err = new Error(message);
  try {
    Object.setPrototypeOf(err, null);
  } catch {}
  return err;
}

/**
 * Creates a defensive proxy membrane around host objects to prevent
 * constructor / prototype traversal and RCE escapes within vm context.
 */
function createSecureMembrane<T extends object>(target: T): T {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return target;
  }

  const handler: ProxyHandler<any> = {
    get(t, prop, receiver) {
      if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') {
        throw createSecureError(`Security Violation: Access to '${String(prop)}' is forbidden in sandbox.`);
      }
      const val = Reflect.get(t, prop, receiver);
      if (val !== null && (typeof val === 'object' || typeof val === 'function')) {
        return createSecureMembrane(val);
      }
      return val;
    },
    has(t, prop) {
      if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') {
        return false;
      }
      return Reflect.has(t, prop);
    },
    ownKeys(t) {
      return Reflect.ownKeys(t).filter(
        k => k !== 'constructor' && k !== '__proto__' && k !== 'prototype'
      );
    },
    getPrototypeOf() {
      return null;
    },
    setPrototypeOf() {
      throw createSecureError('Security Violation: Prototype mutation is forbidden in sandbox.');
    },
    defineProperty() {
      throw createSecureError('Security Violation: Defining properties is forbidden on sandbox objects.');
    },
    deleteProperty(t, prop) {
      if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') {
        throw createSecureError(`Security Violation: Deleting '${String(prop)}' is forbidden in sandbox.`);
      }
      return Reflect.deleteProperty(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    apply(t, thisArg, argList) {
      try {
        const result = Reflect.apply(t, thisArg, argList);
        if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
          return createSecureMembrane(result);
        }
        return result;
      } catch (err: any) {
        if (err && typeof err === 'object') {
          try {
            Object.setPrototypeOf(err, null);
          } catch {}
        }
        throw err;
      }
    },
    construct(t, argList, newTarget) {
      try {
        const result = Reflect.construct(t, argList, newTarget);
        if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
          return createSecureMembrane(result);
        }
        return result;
      } catch (err: any) {
        if (err && typeof err === 'object') {
          try {
            Object.setPrototypeOf(err, null);
          } catch {}
        }
        throw err;
      }
    }
  };

  return new Proxy(target, handler);
}

export class ScriptSandbox {
  public static execute(
    script: string,
    variables: Record<string, string>,
    responseContext?: {
      code: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      responseTimeMs: number;
    }
  ): SandboxExecutionResult {
    const updatedVars = { ...variables };
    const testResults: TestAssertionResult[] = [];
    const logs: string[] = [];

    // Helper chai-like expect implementation with full negation (.not)
    const createExpectation = (actual: any, isNegated = false): any => {
      const assert = (condition: boolean, message: string) => {
        if (isNegated ? condition : !condition) {
          throw createSecureError(message);
        }
      };

      return {
        get not() {
          return createExpectation(actual, !isNegated);
        },
        get to() {
          return createExpectation(actual, isNegated);
        },
        equal: (expected: any) => {
          assert(
            actual === expected,
            `expected ${JSON.stringify(actual)} to ${isNegated ? 'not ' : ''}equal ${JSON.stringify(expected)}`
          );
        },
        eql: (expected: any) => {
          assert(
            JSON.stringify(actual) === JSON.stringify(expected),
            `expected deep equality, got ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`
          );
        },
        deep: {
          equal: (expected: any) => {
            assert(
              JSON.stringify(actual) === JSON.stringify(expected),
              `expected deep equality, got ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`
            );
          }
        },
        be: {
          get ok() {
            assert(Boolean(actual), `expected ${JSON.stringify(actual)} to ${isNegated ? 'not ' : ''}be truthy`);
            return true;
          },
          get true() {
            assert(actual === true, `expected ${actual} to ${isNegated ? 'not ' : ''}be true`);
            return true;
          },
          get false() {
            assert(actual === false, `expected ${actual} to ${isNegated ? 'not ' : ''}be false`);
            return true;
          },
          get null() {
            assert(actual === null, `expected ${actual} to ${isNegated ? 'not ' : ''}be null`);
            return true;
          },
          get undefined() {
            assert(actual === undefined, `expected ${actual} to ${isNegated ? 'not ' : ''}be undefined`);
            return true;
          },
          get empty() {
            let isEmpty = false;
            if (actual == null) isEmpty = true;
            else if (typeof actual === 'string' || Array.isArray(actual)) isEmpty = actual.length === 0;
            else if (typeof actual === 'object') isEmpty = Object.keys(actual).length === 0;
            assert(isEmpty, `expected ${JSON.stringify(actual)} to ${isNegated ? 'not ' : ''}be empty`);
            return true;
          },
          a: (type: string) => {
            const actualType = Array.isArray(actual) ? 'array' : typeof actual;
            assert(
              actualType === type.toLowerCase(),
              `expected ${JSON.stringify(actual)} to ${isNegated ? 'not ' : ''}be a ${type}`
            );
          },
          an: (type: string) => {
            const actualType = Array.isArray(actual) ? 'array' : typeof actual;
            assert(
              actualType === type.toLowerCase(),
              `expected ${JSON.stringify(actual)} to ${isNegated ? 'not ' : ''}be an ${type}`
            );
          },
          oneOf: (arr: any[]) => {
            assert(
              arr.includes(actual),
              `expected ${JSON.stringify(actual)} to ${isNegated ? 'not ' : ''}be one of [${arr.join(', ')}]`
            );
          },
          above: (n: number) => {
            assert(actual > n, `expected ${actual} to ${isNegated ? 'not ' : ''}be above ${n}`);
          },
          below: (n: number) => {
            assert(actual < n, `expected ${actual} to ${isNegated ? 'not ' : ''}be below ${n}`);
          }
        },
        have: {
          property: (prop: string, val?: any) => {
            const hasProp = actual !== null && typeof actual === 'object' && prop in actual;
            assert(hasProp, `expected target to ${isNegated ? 'not ' : ''}have property '${prop}'`);
            if (val !== undefined && hasProp) {
              assert(
                actual[prop] === val,
                `expected property '${prop}' to equal ${JSON.stringify(val)}, got ${JSON.stringify(actual[prop])}`
              );
            }
          },
          length: (len: number) => {
            const actualLen = actual?.length;
            assert(actualLen === len, `expected length ${len}, got ${actualLen}`);
          },
          members: (subset: any[]) => {
            const matches = Array.isArray(actual) && subset.every(s => actual.includes(s));
            assert(matches, `expected array to contain members ${JSON.stringify(subset)}`);
          },
          status: (codeOrCodes: number | number[]) => {
            if (responseContext) {
              const match = Array.isArray(codeOrCodes)
                ? codeOrCodes.includes(responseContext.code)
                : responseContext.code === codeOrCodes;
              assert(match, `expected status ${responseContext.code} to ${isNegated ? 'not ' : ''}equal ${codeOrCodes}`);
            }
          }
        },
        include: (item: any) => {
          let includes = false;
          if (typeof actual === 'string' || Array.isArray(actual)) {
            includes = actual.includes(item);
          } else if (actual && typeof actual === 'object') {
            includes = item in actual || Object.values(actual).includes(item);
          }
          assert(includes, `expected ${JSON.stringify(actual)} to ${isNegated ? 'not ' : ''}include ${JSON.stringify(item)}`);
        }
      };
    };

    // Postman-compatible pm.response.to assertions
    const createResponseAssertions = (respCtx?: typeof responseContext, isNegated = false): any => {
      const assert = (condition: boolean, message: string) => {
        if (isNegated ? condition : !condition) {
          throw createSecureError(message);
        }
      };

      return {
        get not() {
          return createResponseAssertions(respCtx, !isNegated);
        },
        get be() {
          return {
            get ok() {
              const isOk = Boolean(respCtx && respCtx.code >= 200 && respCtx.code < 300);
              assert(isOk, `expected response status ${respCtx?.code} to ${isNegated ? 'not ' : ''}be 2xx OK`);
              return true;
            },
            get json() {
              let isJson = false;
              try {
                JSON.parse(respCtx?.body || '');
                isJson = true;
              } catch {
                isJson = false;
              }
              assert(isJson, `expected response body to ${isNegated ? 'not ' : ''}be valid JSON`);
              return true;
            }
          };
        },
        get have() {
          return {
            status: (codeOrCodes: number | number[]) => {
              if (Array.isArray(codeOrCodes)) {
                const match = respCtx ? codeOrCodes.includes(respCtx.code) : false;
                assert(match, `expected status code to be one of [${codeOrCodes.join(', ')}], got ${respCtx?.code}`);
              } else {
                const match = respCtx?.code === codeOrCodes;
                assert(match, `expected status code ${codeOrCodes}, got ${respCtx?.code}`);
              }
            },
            header: (headerName: string, expectedVal?: string) => {
              const nameLower = headerName.toLowerCase();
              const headers = respCtx?.headers || {};
              const foundKey = Object.keys(headers).find(k => k.toLowerCase() === nameLower);
              const actualVal = foundKey !== undefined ? headers[foundKey] : undefined;

              if (expectedVal !== undefined) {
                const valMatch = foundKey !== undefined && (actualVal === expectedVal || (typeof actualVal === 'string' && actualVal.includes(expectedVal)));
                assert(
                  valMatch,
                  `expected header '${headerName}' to ${isNegated ? 'not ' : ''}match '${expectedVal}', got '${actualVal}'`
                );
              } else {
                assert(foundKey !== undefined, `expected response to ${isNegated ? 'not ' : ''}have header '${headerName}'`);
              }
            },
            body: (expected?: string) => {
              if (expected !== undefined) {
                const match = respCtx?.body === expected;
                assert(match, `expected response body to ${isNegated ? 'not ' : ''}equal '${expected}'`);
              } else {
                assert(Boolean(respCtx?.body && respCtx.body.trim().length > 0), `expected response to have non-empty body`);
              }
            }
          };
        }
      };
    };

    const pm = {
      environment: {
        get: (key: string) => updatedVars[key],
        set: (key: string, val: any) => {
          updatedVars[key] = String(val);
        }
      },
      variables: {
        get: (key: string) => updatedVars[key],
        set: (key: string, val: any) => {
          updatedVars[key] = String(val);
        }
      },
      expect: (actual: any) => createExpectation(actual, false),
      test: (name: string, fn: () => void) => {
        try {
          fn();
          testResults.push({ name, passed: true });
        } catch (err: any) {
          testResults.push({ name, passed: false, error: err.message || String(err) });
        }
      },
      response: responseContext
        ? {
            code: responseContext.code,
            status: responseContext.statusText,
            headers: responseContext.headers,
            responseTime: responseContext.responseTimeMs,
            text: () => responseContext.body,
            json: () => {
              try {
                const parsed = JSON.parse(responseContext.body);
                return createSecureMembrane(parsed);
              } catch {
                throw createSecureError('Response body is not valid JSON');
              }
            },
            get to() {
              return createResponseAssertions(responseContext, false);
            }
          }
        : undefined
    };

    const rawConsole = {
      log: (...args: any[]) =>
        logs.push(args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ')),
      error: (...args: any[]) =>
        logs.push(`[ERROR] ${args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ')}`),
      warn: (...args: any[]) =>
        logs.push(`[WARN] ${args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ')}`)
    };

    // Defensive sandbox environment
    const rawSandbox = {
      pm,
      console: rawConsole,
      JSON: {
        parse: (text: string) => {
          const parsed = JSON.parse(text);
          return createSecureMembrane(parsed);
        },
        stringify: (value: any, replacer?: any, space?: any) => JSON.stringify(value, replacer, space)
      },
      Date,
      Math
    };

    // Wrap the sandbox globals with the security membrane
    const secureSandbox = createSecureMembrane(rawSandbox);

    try {
      const context = vm.createContext(secureSandbox);
      vm.runInContext(script, context, { timeout: 2000 });
    } catch (err: any) {
      testResults.push({
        name: 'Script Execution',
        passed: false,
        error: `Script failed: ${err.message || String(err)}`
      });
    }

    return {
      updatedVariables: updatedVars,
      testResults,
      logs
    };
  }
}

import { describe, it, expect } from 'vitest';
import { ScriptSandbox } from '../src/core/engine/ScriptSandbox.js';

describe('ScriptSandbox', () => {
  it('executes assertions with pm.test and pm.expect', () => {
    const script = `
      pm.test("Status code is 200", function() {
        pm.expect(pm.response.code).to.equal(200);
      });

      pm.test("JSON payload has message", function() {
        var data = pm.response.json();
        pm.expect(data.msg).to.equal("success");
      });

      pm.environment.set("authToken", "xyz-123");
    `;

    const res = ScriptSandbox.execute(
      script,
      { initialVar: 'true' },
      {
        code: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg: 'success', count: 5 }),
        responseTimeMs: 25
      }
    );

    expect(res.testResults.length).toBe(2);
    expect(res.testResults[0].passed).toBe(true);
    expect(res.testResults[1].passed).toBe(true);
    expect(res.updatedVariables.authToken).toBe('xyz-123');
  });

  it('reports failing tests accurately with clear message', () => {
    const script = `
      pm.test("Status code should be 201", function() {
        pm.expect(pm.response.code).to.equal(201);
      });
    `;

    const res = ScriptSandbox.execute(
      script,
      {},
      {
        code: 400,
        statusText: 'Bad Request',
        headers: {},
        body: '',
        responseTimeMs: 15
      }
    );

    expect(res.testResults.length).toBe(1);
    expect(res.testResults[0].passed).toBe(false);
    expect(res.testResults[0].error).toContain('expected 400 to equal 201');
  });

  it('prevents RCE prototype constructor escape attacks across all vectors', () => {
    // 1. Math / Date / Object prototype access
    const mathScript = `
      try {
        var hostFn = Math.constructor.constructor("return process");
        var proc = hostFn();
        pm.environment.set("escaped_math", "true");
      } catch (e) {
        pm.environment.set("blocked_math", e.message);
      }
    `;
    const resMath = ScriptSandbox.execute(mathScript, {});
    expect(resMath.updatedVariables.escaped_math).toBeUndefined();
    expect(resMath.updatedVariables.blocked_math).toContain('Security Violation');

    // 2. pm.response.json() return value prototype traversal
    const jsonScript = `
      try {
        var data = pm.response.json();
        var hostFn = data.constructor.constructor("return process");
        var proc = hostFn();
        pm.environment.set("escaped_json_resp", "true");
      } catch (e) {
        pm.environment.set("blocked_json_resp", e.message);
      }
    `;
    const resJson = ScriptSandbox.execute(
      jsonScript,
      {},
      { code: 200, statusText: 'OK', headers: {}, body: '{"key":"val"}', responseTimeMs: 10 }
    );
    expect(resJson.updatedVariables.escaped_json_resp).toBeUndefined();
    expect(resJson.updatedVariables.blocked_json_resp).toContain('Security Violation');

    // 3. JSON.parse() return value prototype traversal
    const parseScript = `
      try {
        var parsed = JSON.parse('{"secure": true}');
        var hostFn = parsed.constructor.constructor("return process");
        var proc = hostFn();
        pm.environment.set("escaped_parse", "true");
      } catch (e) {
        pm.environment.set("blocked_parse", e.message);
      }
    `;
    const resParse = ScriptSandbox.execute(parseScript, {});
    expect(resParse.updatedVariables.escaped_parse).toBeUndefined();
    expect(resParse.updatedVariables.blocked_parse).toContain('Security Violation');

    // 4. Caught assertion error prototype traversal
    const errScript = `
      try {
        pm.expect(1).to.equal(2);
      } catch (err) {
        try {
          var hostFn = err.constructor.constructor("return process");
          var proc = hostFn();
          pm.environment.set("escaped_err", "true");
        } catch (e) {
          pm.environment.set("blocked_err", e.message);
        }
      }
    `;
    const resErr = ScriptSandbox.execute(errScript, {});
    expect(resErr.updatedVariables.escaped_err).toBeUndefined();
    // In safe error, prototype is null so err.constructor is undefined, throwing TypeError
    expect(resErr.updatedVariables.blocked_err).toBeDefined();
  });

  it('supports full Postman Chai pm.response.to assertions and negation', () => {
    const script = `
      pm.test("Status assertions", function() {
        pm.response.to.have.status(200);
        pm.response.to.have.status([200, 201]);
        pm.response.to.not.have.status(404);
        pm.response.to.not.have.status([404, 500]);
        pm.response.to.be.ok;
      });

      pm.test("Body and header assertions", function() {
        pm.response.to.be.json;
        pm.response.to.have.header("Content-Type");
        pm.response.to.have.header("Content-Type", "application/json");
        pm.response.to.not.have.header("Content-Type", "text/html");
        pm.response.to.not.have.header("X-Missing-Header");
        pm.response.to.have.body(JSON.stringify({ ok: true }));
      });

      pm.test("Expect chaining and types", function() {
        pm.expect("hello").to.be.a("string");
        pm.expect([1, 2, 3]).to.have.length(3);
        pm.expect([]).to.be.empty;
        pm.expect({ name: "Rea" }).to.have.property("name", "Rea");
      });
    `;

    const res = ScriptSandbox.execute(
      script,
      {},
      {
        code: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
        responseTimeMs: 10
      }
    );

    expect(res.testResults.length).toBe(3);
    expect(res.testResults[0].passed).toBe(true);
    expect(res.testResults[1].passed).toBe(true);
    expect(res.testResults[2].passed).toBe(true);
  });

  it('captures console.log, console.warn, and console.error output', () => {
    const script = `
      console.log("Starting test run", { step: 1 });
      console.warn("High latency detected");
      console.error("Critical missing field");
    `;

    const res = ScriptSandbox.execute(script, {});
    expect(res.logs.length).toBe(3);
    expect(res.logs[0]).toContain('Starting test run');
    expect(res.logs[0]).toContain('{"step":1}');
    expect(res.logs[1]).toContain('[WARN] High latency detected');
    expect(res.logs[2]).toContain('[ERROR] Critical missing field');
  });
});

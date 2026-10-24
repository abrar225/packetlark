import { describe, it, expect } from 'vitest';
import { VariableResolver } from '../src/core/engine/VariableResolver.js';

describe('VariableResolver', () => {
  it('resolves variables from context correctly', () => {
    const context = { baseUrl: 'https://api.test.com', id: '99' };
    const res = VariableResolver.resolve('{{baseUrl}}/users/{{id}}', context);
    expect(res).toBe('https://api.test.com/users/99');
  });

  it('generates dynamic variables like $guid, $timestamp, $randomInt, $isoTimestamp', () => {
    const text = 'id={{$guid}}&ts={{$timestamp}}&rand={{$randomInt}}&iso={{$isoTimestamp}}';
    const resolved = VariableResolver.resolve(text, {});
    expect(resolved).not.toContain('{{$guid}}');
    expect(resolved).not.toContain('{{$timestamp}}');
    expect(resolved).not.toContain('{{$randomInt}}');
    expect(resolved).not.toContain('{{$isoTimestamp}}');
    expect(resolved).toMatch(/id=[0-9a-f-]+&ts=\d+&rand=\d+&iso=\d{4}-\d{2}-\d{2}/);
  });

  it('tolerates whitespace inside variable brackets {{ variable }}', () => {
    const context = { host: 'localhost', port: '8080' };
    const res = VariableResolver.resolve('http://{{  host  }}:{{ port }}/api', context);
    expect(res).toBe('http://localhost:8080/api');
  });

  it('resolves recursive variable references up to max depth', () => {
    const context = {
      protocol: 'https',
      domain: 'api.example.com',
      base: '{{protocol}}://{{domain}}',
      endpoint: '{{base}}/v1/users'
    };
    const res = VariableResolver.resolve('{{endpoint}}', context);
    expect(res).toBe('https://api.example.com/v1/users');
  });

  it('correctly builds context honoring precedence hierarchy (collection < environment < runtime)', () => {
    const colVars = [
      { key: 'target', value: 'col-target', enabled: true },
      { key: 'colOnly', value: 'from-col', enabled: true }
    ];
    const envVars = [
      { key: 'target', value: 'env-target', enabled: true },
      { key: 'envOnly', value: 'from-env', enabled: true }
    ];
    const runtimeVars = {
      target: 'runtime-target'
    };

    const ctx = VariableResolver.buildContext(colVars, envVars, runtimeVars);
    expect(ctx.colOnly).toBe('from-col');
    expect(ctx.envOnly).toBe('from-env');
    expect(ctx.target).toBe('runtime-target');
  });
});

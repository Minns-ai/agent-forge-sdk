import { describe, it, expect, vi } from 'vitest';
import { MiddlewareStack } from '../../src/middleware/stack.js';
import type { Middleware, PipelineState, MiddlewareContext, ModelRequest, ModelResponse, NextFn } from '../../src/middleware/types.js';
import type { LLMProvider, LLMMessage } from '../../src/types.js';

// Mock LLM provider
function createMockLlm(response = 'mock response'): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
  } as any;
}

// Minimal pipeline state for testing
function createTestState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    message: 'test message',
    sessionId: 1,
    intent: { type: 'query', details: { raw_message: 'test' }, enable_semantic: false, rich_context: 'test' },
    sessionState: { iterationCount: 0, goalCompleted: false, goalCompletedAt: null, collectedFacts: {}, conversationHistory: [], goalDescription: 'test' },
    memory: { claims: [] },
    plan: '',
    reasoning: [],
    toolResults: [],
    errors: [],
    goalProgress: { completed: false, progress: 0 },
    responseMessage: '',
    complexity: null,
    reflexionContext: { constraints: [], pastFailures: [], learnedLessons: [] },
    toolContext: { agentId: 1, sessionId: 1, memory: { claims: [] }, client: {}, sessionState: {} as any, services: {} },
    middlewareState: {},
    ...overrides,
  };
}

// Minimal middleware context for testing
function createTestContext(llm?: LLMProvider): MiddlewareContext {
  return {
    directive: { identity: 'test', goalDescription: 'test', domain: 'test', maxIterations: 3 },
    llm: llm ?? createMockLlm(),
    client: {},
    agentId: 1,
    toolRegistry: { names: () => [], definitions: () => [], register: vi.fn(), registerAll: vi.fn() } as any,
    emitter: { emit: vi.fn(), on: vi.fn(), complete: vi.fn() } as any,
    services: {},
    timer: { startPhase: vi.fn(), endPhase: vi.fn(), addPhase: vi.fn(), summarize: vi.fn() } as any,
    modelCall: async (req: ModelRequest) => ({ content: 'mock', metadata: {} }),
  };
}

describe('MiddlewareStack', () => {
  it('should start empty', () => {
    const stack = new MiddlewareStack();
    expect(stack.isEmpty).toBe(true);
    expect(stack.size).toBe(0);
    expect(stack.names()).toEqual([]);
  });

  it('should register middlewares', () => {
    const stack = new MiddlewareStack();
    stack.use({ name: 'a' });
    stack.use({ name: 'b' });
    expect(stack.size).toBe(2);
    expect(stack.names()).toEqual(['a', 'b']);
  });

  it('should reject duplicate middleware names', () => {
    const stack = new MiddlewareStack();
    stack.use({ name: 'a' });
    expect(() => stack.use({ name: 'a' })).toThrow('already registered');
  });

  it('should collect tools from all middlewares', () => {
    const stack = new MiddlewareStack();
    stack.use({ name: 'a', tools: [{ name: 'tool_a', description: 'A', parameters: {}, execute: vi.fn() }] });
    stack.use({ name: 'b', tools: [{ name: 'tool_b', description: 'B', parameters: {}, execute: vi.fn() }] });
    const tools = stack.collectTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('tool_a');
    expect(tools[1].name).toBe('tool_b');
  });

  it('should reject duplicate tool names across middlewares', () => {
    const stack = new MiddlewareStack();
    stack.use({ name: 'a', tools: [{ name: 'dupe', description: 'A', parameters: {}, execute: vi.fn() }] });
    stack.use({ name: 'b', tools: [{ name: 'dupe', description: 'B', parameters: {}, execute: vi.fn() }] });
    expect(() => stack.collectTools()).toThrow('conflicts');
  });

  it('should run beforeExecute hooks in order', async () => {
    const order: string[] = [];
    const stack = new MiddlewareStack();
    stack.use({ name: 'first', beforeExecute: async () => { order.push('first'); } });
    stack.use({ name: 'second', beforeExecute: async () => { order.push('second'); } });

    const state = createTestState();
    await stack.runBeforeExecute(state, createTestContext());
    expect(order).toEqual(['first', 'second']);
  });

  it('should run afterExecute hooks in REVERSE order', async () => {
    const order: string[] = [];
    const stack = new MiddlewareStack();
    stack.use({ name: 'first', afterExecute: async () => { order.push('first'); } });
    stack.use({ name: 'second', afterExecute: async () => { order.push('second'); } });

    const state = createTestState();
    await stack.runAfterExecute(state, createTestContext());
    expect(order).toEqual(['second', 'first']);
  });

  it('should apply state updates from beforeExecute', async () => {
    const stack = new MiddlewareStack();
    stack.use({
      name: 'updater',
      beforeExecute: async () => ({ plan: 'new plan' }),
    });

    const state = createTestState();
    await stack.runBeforeExecute(state, createTestContext());
    expect(state.plan).toBe('new plan');
  });

  it('should merge middlewareState per middleware name', async () => {
    const stack = new MiddlewareStack();
    stack.use({
      name: 'mw1',
      beforeExecute: async () => ({
        middlewareState: { mw1: { key: 'value1' } },
      }),
    });
    stack.use({
      name: 'mw2',
      beforeExecute: async () => ({
        middlewareState: { mw2: { key: 'value2' } },
      }),
    });

    const state = createTestState();
    await stack.runBeforeExecute(state, createTestContext());
    expect(state.middlewareState.mw1).toEqual({ key: 'value1' });
    expect(state.middlewareState.mw2).toEqual({ key: 'value2' });
  });

  it('should catch errors in beforeExecute and push to state.errors', async () => {
    const stack = new MiddlewareStack();
    stack.use({
      name: 'broken',
      beforeExecute: async () => { throw new Error('boom'); },
    });

    const state = createTestState();
    await stack.runBeforeExecute(state, createTestContext());
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]).toContain('broken');
    expect(state.errors[0]).toContain('boom');
  });

  it('should build onion-wrapped model call', async () => {
    const order: string[] = [];
    const stack = new MiddlewareStack();

    stack.use({
      name: 'outer',
      wrapModelCall: async (req, next) => {
        order.push('outer-in');
        const res = await next(req);
        order.push('outer-out');
        return res;
      },
    });
    stack.use({
      name: 'inner',
      wrapModelCall: async (req, next) => {
        order.push('inner-in');
        const res = await next(req);
        order.push('inner-out');
        return res;
      },
    });

    const mockLlm = createMockLlm('hello');
    const state = createTestState();
    const context = createTestContext(mockLlm);
    const modelCall = stack.buildModelCall(mockLlm, state, context);

    const response = await modelCall({ messages: [{ role: 'user', content: 'test' }], purpose: 'test', metadata: {} });
    expect(response.content).toBe('hello');
    expect(order).toEqual(['outer-in', 'inner-in', 'inner-out', 'outer-out']);
  });

  it('should apply system prompt modifications', () => {
    const stack = new MiddlewareStack();
    stack.use({
      name: 'appender',
      modifySystemPrompt: (prompt) => prompt + '\n## Added by middleware',
    });

    const messages: LLMMessage[] = [
      { role: 'system', content: 'Base prompt' },
      { role: 'user', content: 'Hello' },
    ];

    const state = createTestState();
    const modified = stack.applySystemPromptModifications(messages, state);
    expect(modified[0].content).toBe('Base prompt\n## Added by middleware');
    expect(modified[1].content).toBe('Hello'); // unchanged
  });

  it('should skip wrapModelCall on error and continue chain', async () => {
    const stack = new MiddlewareStack();
    stack.use({
      name: 'broken',
      wrapModelCall: async () => { throw new Error('middleware exploded'); },
    });

    const mockLlm = createMockLlm('fallback works');
    const state = createTestState();
    const context = createTestContext(mockLlm);
    const modelCall = stack.buildModelCall(mockLlm, state, context);

    const response = await modelCall({ messages: [{ role: 'user', content: 'test' }], purpose: 'test', metadata: {} });
    expect(response.content).toBe('fallback works');
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]).toContain('broken');
  });

  it('should support useAll for bulk registration', () => {
    const stack = new MiddlewareStack();
    stack.useAll([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect(stack.size).toBe(3);
  });

  it('should support middleware that short-circuits wrapModelCall', async () => {
    const stack = new MiddlewareStack();
    stack.use({
      name: 'cached',
      wrapModelCall: async (req) => {
        // Return cached response without calling next
        return { content: 'from cache', metadata: { cached: true } };
      },
    });

    const mockLlm = createMockLlm('should not be called');
    const state = createTestState();
    const context = createTestContext(mockLlm);
    const modelCall = stack.buildModelCall(mockLlm, state, context);

    const response = await modelCall({ messages: [{ role: 'user', content: 'test' }], purpose: 'test', metadata: {} });
    expect(response.content).toBe('from cache');
    expect(mockLlm.complete).not.toHaveBeenCalled();
  });
});

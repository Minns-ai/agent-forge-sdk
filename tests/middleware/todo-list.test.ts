import { describe, it, expect } from 'vitest';
import { TodoListMiddleware } from '../../src/middleware/builtin/todo-list.js';
import type { PipelineState, MiddlewareContext } from '../../src/middleware/types.js';

function createTestState(): PipelineState {
  return {
    message: 'test',
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
  };
}

function createTestContext(): MiddlewareContext {
  return {
    directive: { identity: 'test', goalDescription: 'test', domain: 'test', maxIterations: 3 },
    llm: { complete: async () => 'mock', stream: async function* () {} } as any,
    client: {},
    agentId: 1,
    toolRegistry: { names: () => [], definitions: () => [], register: () => {}, registerAll: () => {} } as any,
    emitter: { emit: () => {}, on: () => {}, complete: () => {} } as any,
    services: {},
    timer: { startPhase: () => {}, endPhase: () => ({}), addPhase: () => {}, summarize: () => ({}) } as any,
    modelCall: async () => ({ content: 'mock', metadata: {} }),
  };
}

describe('TodoListMiddleware', () => {
  it('should have name and tools', () => {
    const mw = new TodoListMiddleware();
    expect(mw.name).toBe('todo-list');
    expect(mw.tools).toHaveLength(2);
    expect(mw.tools![0].name).toBe('write_todos');
    expect(mw.tools![1].name).toBe('get_todos');
  });

  it('should create todos via write_todos tool', async () => {
    const mw = new TodoListMiddleware();
    const state = createTestState();
    await mw.beforeExecute!(state, createTestContext());

    const writeTool = mw.tools![0];
    const result = await writeTool.execute({
      action: 'create',
      items: JSON.stringify([
        { title: 'Task 1', description: 'First task' },
        { title: 'Task 2', description: 'Second task', priority: 0 },
      ]),
    }, state.toolContext);

    expect(result.success).toBe(true);
    expect(result.result.created).toBe(2);
    expect(result.result.total).toBe(2);
  });

  it('should retrieve todos via get_todos tool', async () => {
    const mw = new TodoListMiddleware();
    const state = createTestState();
    await mw.beforeExecute!(state, createTestContext());

    // Create some todos
    await mw.tools![0].execute({
      action: 'create',
      items: JSON.stringify([
        { title: 'Task A' },
        { title: 'Task B' },
      ]),
    }, state.toolContext);

    // Get all todos
    const getTool = mw.tools![1];
    const result = await getTool.execute({}, state.toolContext);

    expect(result.success).toBe(true);
    expect(result.result.items).toHaveLength(2);
    expect(result.result.summary.total).toBe(2);
    expect(result.result.summary.pending).toBe(2);
  });

  it('should update todo status', async () => {
    const mw = new TodoListMiddleware();
    const state = createTestState();
    await mw.beforeExecute!(state, createTestContext());

    // Create a todo
    await mw.tools![0].execute({
      action: 'create',
      items: JSON.stringify([{ title: 'Task 1' }]),
    }, state.toolContext);

    // Update to completed
    const result = await mw.tools![0].execute({
      action: 'update',
      items: JSON.stringify({ id: 1, status: 'completed' }),
    }, state.toolContext);

    expect(result.success).toBe(true);
    expect(result.result.updated.status).toBe('completed');
    expect(result.result.completed).toBe(1);
  });

  it('should clear all todos', async () => {
    const mw = new TodoListMiddleware();
    const state = createTestState();
    await mw.beforeExecute!(state, createTestContext());

    await mw.tools![0].execute({
      action: 'create',
      items: JSON.stringify([{ title: 'A' }, { title: 'B' }]),
    }, state.toolContext);

    const result = await mw.tools![0].execute({ action: 'clear' }, state.toolContext);
    expect(result.success).toBe(true);
    expect(result.result.cleared).toBe(2);
  });

  it('should inject todo state into system prompt', async () => {
    const mw = new TodoListMiddleware();
    const state = createTestState();
    await mw.beforeExecute!(state, createTestContext());

    await mw.tools![0].execute({
      action: 'create',
      items: JSON.stringify([{ title: 'Write tests' }]),
    }, state.toolContext);

    const modified = mw.modifySystemPrompt!('Base prompt', state);
    expect(modified).toContain('Task Planning');
    expect(modified).toContain('Write tests');
    expect(modified).toContain('PENDING');
  });

  it('should filter todos by status', async () => {
    const mw = new TodoListMiddleware();
    const state = createTestState();
    await mw.beforeExecute!(state, createTestContext());

    await mw.tools![0].execute({
      action: 'create',
      items: JSON.stringify([{ title: 'A' }, { title: 'B' }]),
    }, state.toolContext);

    await mw.tools![0].execute({
      action: 'update',
      items: JSON.stringify({ id: 1, status: 'completed' }),
    }, state.toolContext);

    const result = await mw.tools![1].execute({ filter: 'pending' }, state.toolContext);
    expect(result.result.items).toHaveLength(1);
    expect(result.result.items[0].title).toBe('B');
  });
});

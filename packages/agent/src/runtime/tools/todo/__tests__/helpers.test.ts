import { describe, it, expect } from '@jest/globals';
import type { AgentState } from '@strands-agents/sdk';
import { formatTodoList, getTodoList, saveTodoList } from '../helpers.js';
import type { TodoList } from '../types.js';

const mockState = (): AgentState => {
  const data = new Map<string, unknown>();
  return {
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => {
      data.set(key, value);
    },
  } as unknown as AgentState;
};

describe('formatTodoList', () => {
  it('should return empty string for null', () => {
    expect(formatTodoList(null)).toBe('');
  });

  it('should return empty string for empty items array', () => {
    const todoList: TodoList = { items: [], lastUpdated: Date.now() };
    expect(formatTodoList(todoList)).toBe('');
  });

  it('should format a single item correctly', () => {
    const todoList: TodoList = {
      items: [
        {
          id: '1',
          description: 'Write tests',
          status: 'pending',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      lastUpdated: 0,
    };
    const result = formatTodoList(todoList);
    expect(result).toContain('## Todo List\n');
    expect(result).toContain('- id:1 (pending) Write tests\n');
  });

  it('should format multiple items with different statuses', () => {
    const todoList: TodoList = {
      items: [
        { id: '1', description: 'Task one', status: 'pending', createdAt: 0, updatedAt: 0 },
        { id: '2', description: 'Task two', status: 'in_progress', createdAt: 0, updatedAt: 0 },
        { id: '3', description: 'Task three', status: 'completed', createdAt: 0, updatedAt: 0 },
        { id: '4', description: 'Task four', status: 'cancelled', createdAt: 0, updatedAt: 0 },
      ],
      lastUpdated: 0,
    };
    const result = formatTodoList(todoList);
    expect(result).toContain('- id:1 (pending) Task one\n');
    expect(result).toContain('- id:2 (in_progress) Task two\n');
    expect(result).toContain('- id:3 (completed) Task three\n');
    expect(result).toContain('- id:4 (cancelled) Task four\n');
  });

  it('should use the correct markdown format', () => {
    const todoList: TodoList = {
      items: [
        { id: 'abc', description: 'Do something', status: 'completed', createdAt: 0, updatedAt: 0 },
      ],
      lastUpdated: 0,
    };
    const result = formatTodoList(todoList);
    expect(result).toBe('## Todo List\n- id:abc (completed) Do something\n');
  });
});

describe('getTodoList', () => {
  it('should return null when state has no todo data', () => {
    const state = mockState();
    expect(getTodoList(state)).toBeNull();
  });

  it('should return null when stored data has no items property', () => {
    const state = mockState();
    state.set('todoList', { something: 'else' });
    expect(getTodoList(state)).toBeNull();
  });

  it('should return TodoList when valid data is stored', () => {
    const state = mockState();
    const todoList: TodoList = {
      items: [{ id: '1', description: 'Test task', status: 'pending', createdAt: 0, updatedAt: 0 }],
      lastUpdated: 12345,
    };
    state.set('todoList', todoList);
    expect(getTodoList(state)).toEqual(todoList);
  });
});

describe('saveTodoList', () => {
  it('should persist and retrieve a TodoList via roundtrip', () => {
    const state = mockState();
    const todoList: TodoList = {
      items: [
        {
          id: '42',
          description: 'Roundtrip task',
          status: 'in_progress',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      lastUpdated: 9999,
    };
    saveTodoList(state, todoList);
    expect(getTodoList(state)).toEqual(todoList);
  });

  it('should overwrite previously saved TodoList', () => {
    const state = mockState();
    const first: TodoList = {
      items: [{ id: '1', description: 'First', status: 'pending', createdAt: 0, updatedAt: 0 }],
      lastUpdated: 0,
    };
    const second: TodoList = {
      items: [{ id: '2', description: 'Second', status: 'completed', createdAt: 0, updatedAt: 0 }],
      lastUpdated: 1,
    };
    saveTodoList(state, first);
    saveTodoList(state, second);
    expect(getTodoList(state)).toEqual(second);
  });
});

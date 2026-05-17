import type { AgentState } from '@strands-agents/sdk';
import type { TodoList } from './types.js';

const TODO_STATE_KEY = 'todoList';

export function getTodoList(state: AgentState): TodoList | null {
  const data = state.get(TODO_STATE_KEY) as unknown;
  if (!data || !(data as TodoList).items) {
    return null;
  }
  return data as TodoList;
}

export function saveTodoList(state: AgentState, todoList: TodoList): void {
  state.set(TODO_STATE_KEY, todoList);
}

export function formatTodoList(todoList: TodoList | null): string {
  if (!todoList || todoList.items.length === 0) {
    return '';
  }

  let markdown = '## Todo List\n';

  todoList.items.forEach((item) => {
    markdown += `- id:${item.id} (${item.status}) ${item.description}\n`;
  });

  return markdown;
}

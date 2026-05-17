/**
 * Unified Todo Tool
 * Manage a todo list for tracking task progress during sessions.
 * Supports 'init' and 'update' actions via the action parameter.
 */

import { tool } from '@strands-agents/sdk';
import { todoDefinition } from '@moca/tool-definitions';
import { logger } from '../../../libs/logger/index.js';
import { getTodoList, saveTodoList, formatTodoList } from './helpers.js';
import type { TodoList, TodoItemUpdate } from './types.js';

/**
 * Handle init action - create or overwrite a todo list
 */
function handleInit(items: string[], state: unknown): string {
  logger.info(`Todo init: creating ${items.length} tasks`);

  const existing = state ? getTodoList(state as Parameters<typeof getTodoList>[0]) : null;
  if (existing) {
    logger.info('Overwriting existing todo list');
  }

  const now = Date.now();
  const todoList: TodoList = {
    items: items.map((description, index) => ({
      id: `task-${index + 1}`,
      description,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    })),
    lastUpdated: now,
  };

  if (state) {
    saveTodoList(state as Parameters<typeof saveTodoList>[0], todoList);
  }

  return formatTodoList(todoList);
}

/**
 * Handle update action - modify tasks in the existing todo list
 */
function handleUpdate(updates: TodoItemUpdate[], state: unknown): string {
  logger.info(`Todo update: processing ${updates.length} update(s)`);

  const todoList = state ? getTodoList(state as Parameters<typeof getTodoList>[0]) : null;
  if (!todoList) {
    return "No todo list exists. Please create one first using todo with action 'init'.";
  }

  const now = Date.now();
  const updatedItems = [...todoList.items];

  for (const update of updates) {
    const taskIndex = updatedItems.findIndex((task) => task.id === update.id);
    if (taskIndex === -1) {
      const currentList = formatTodoList(todoList);
      return `Update failed: Task id ${update.id} was not found.\n\n${currentList}`;
    }

    updatedItems[taskIndex] = {
      ...updatedItems[taskIndex],
      status: update.status,
      description: update.description ?? updatedItems[taskIndex].description,
      updatedAt: now,
    };
  }

  const updatedList: TodoList = {
    items: updatedItems,
    lastUpdated: now,
  };

  // Validate: only one task can be in_progress at a time
  if (updatedList.items.filter((item) => item.status === 'in_progress').length > 1) {
    const currentList = formatTodoList(todoList);
    return `Update failed: Only one task can be in progress at a time.\n\n${currentList}`;
  }

  if (state) {
    saveTodoList(state as Parameters<typeof saveTodoList>[0], updatedList);
  }

  const formattedList = formatTodoList(updatedList);

  let message: string;
  if (updates.length === 1) {
    message = `Task ${updates[0].id} updated to status: ${updates[0].status}`;
  } else {
    message = `${updates.length} tasks updated successfully`;
  }

  return `${message}\n\n${formattedList}`;
}

/**
 * Unified Todo Tool Implementation
 */
export const todoTool = tool({
  name: todoDefinition.name,
  description: todoDefinition.description,
  inputSchema: todoDefinition.zodSchema,
  callback: async (input, context) => {
    const { action } = input;
    const state = context?.agent?.state;

    switch (action) {
      case 'init': {
        if (!input.items || input.items.length === 0) {
          return "Error: 'items' parameter is required for init action. Provide an array of task descriptions.";
        }
        return handleInit(input.items, state);
      }
      case 'update': {
        if (!input.updates || input.updates.length === 0) {
          return "Error: 'updates' parameter is required for update action. Provide an array of task updates.";
        }
        return handleUpdate(input.updates as TodoItemUpdate[], state);
      }
      default:
        return `Unknown action: ${action}. Valid actions are: init, update`;
    }
  },
});

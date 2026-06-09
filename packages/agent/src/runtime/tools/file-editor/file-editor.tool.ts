/**
 * File Editor Tool - Safely edit or create files
 */

import { fileEditorDefinition } from '@moca/tool-definitions';
import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { logger } from '../../../libs/logger/index.js';
import { toDisplayPath } from '../../../libs/utils/display-path.js';
import { getCurrentContext } from '../../../libs/context/request-context.js';
import { defineTool } from '../_shared/index.js';
import { isSingleOccurrence } from './match.js';

/**
 * File Editor Tool
 *
 * Returns guidance strings for recoverable conditions (file missing, ambiguous
 * match, etc.). Unexpected I/O failures throw and are formatted by `defineTool`.
 */
export const fileEditorTool = defineTool(fileEditorDefinition, async (input) => {
  const { filePath, oldString, newString } = input;

  logger.info(`File editor operation started: ${filePath}`);

  // Wait for workspace sync to complete
  const workspaceSync = getCurrentContext()?.workspaceSync;
  if (workspaceSync) {
    await workspaceSync.waitForInitialSync();
  }

  // Check if file exists
  const fileExists = await access(filePath)
    .then(() => true)
    .catch(() => false);

  if (!fileExists) {
    // File doesn't exist
    if (oldString) {
      const msg = `The file does not exist. Please check again.`;
      logger.warn(`${msg} - Path: ${filePath}`);
      return msg;
    }
    // Create parent directories if they don't exist
    await mkdir(dirname(filePath), { recursive: true });
    // Create new file with newString content
    await writeFile(filePath, newString, 'utf8');
    logger.info(`Successfully created the file: ${filePath}`);
    const displayPath = toDisplayPath(filePath);
    return `File created successfully
Operation: CREATE
File path: ${filePath}
Display path: ${displayPath}

To reference this file in chat, use: ${displayPath}`;
  }

  // File exists - check if we can edit
  if (!oldString) {
    const msg = `The file already exists. Please provide a non-empty oldString to edit it.`;
    logger.warn(`${msg} - Path: ${filePath}`);
    return msg;
  }

  // Read file contents
  const fileContents = await readFile(filePath, 'utf8');

  // Check if oldString exists and appears only once
  const isValid = isSingleOccurrence(fileContents, oldString);

  if (isValid === undefined) {
    const msg = `The file does not contain the oldString. Please check again.`;
    logger.warn(`${msg} - Path: ${filePath}`);
    return msg;
  }

  if (!isValid) {
    const msg = `The file contains multiple occurrences of the oldString. Only one occurrence is allowed.`;
    logger.warn(`${msg} - Path: ${filePath}`);
    return msg;
  }

  // Replace oldString with newString
  const updatedContents = fileContents.replace(oldString, newString);
  await writeFile(filePath, updatedContents, 'utf8');

  logger.info(`Successfully edited the file: ${filePath}`);
  const displayPath = toDisplayPath(filePath);
  return `File edited successfully
Operation: EDIT
File path: ${filePath}
Display path: ${displayPath}

To reference this file in chat, use: ${displayPath}`;
});

/**
 * Echo tool implementation
 *
 * Returns the input message as-is along with text transformations.
 */

import { ToolInput, ToolResult, Tool, ToolValidationError, logger } from '@moca/lambda-tools-shared';

/**
 * Echo tool input type
 */
interface EchoInput extends ToolInput {
  message?: string;
}

/**
 * Echo tool output type
 */
interface EchoResult extends ToolResult {
  echo: string;
  length: number;
  uppercase: string;
  lowercase: string;
}

/**
 * Main handler for the echo tool
 *
 * @param input - Tool input data
 * @returns Echo result with text transformations
 */
async function handleEcho(input: ToolInput): Promise<EchoResult> {
  const echoInput = input as EchoInput;

  if (echoInput.message === undefined || echoInput.message === null) {
    throw new ToolValidationError("Echo tool requires a 'message' parameter", 'echo', 'message');
  }

  const message = echoInput.message;
  const messageAnalysis = analyzeMessage(message);

  logger.debug('ECHO_RESULT', {
    messageLength: message.length,
    ...messageAnalysis,
  });

  const result: EchoResult = {
    echo: message,
    length: message.length,
    uppercase: message.toUpperCase(),
    lowercase: message.toLowerCase(),
  };

  return result;
}

/**
 * Analyze message characteristics
 *
 * @param message - Message to analyze
 * @returns Message characteristic metrics
 */
function analyzeMessage(message: string) {
  return {
    hasUppercase: /[A-Z]/.test(message),
    hasLowercase: /[a-z]/.test(message),
    hasNumbers: /\d/.test(message),
    hasSpecialChars: /[^a-zA-Z0-9\s]/.test(message),
    wordCount: message.trim().split(/\s+/).length,
    charCount: message.length,
    whitespaceCount: (message.match(/\s/g) || []).length,
  };
}

/**
 * Echo tool definition
 */
export const echoTool: Tool = {
  name: 'echo',
  handler: handleEcho,
  description: 'Echo back the input message with additional transformations',
  version: '1.0.0',
  tags: ['utility', 'text-processing'],
};

export default echoTool;

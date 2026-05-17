import { RUNTIME_TOOL_NAMES } from '@moca/tool-definitions';

const WORKSPACE_DIR = '/tmp/ws';
/**
 * Generate default context
 * @param tools List of enabled tools
 */
export function generateDefaultContext(
  tools: Array<{ name: string; description?: string }>
): string {
  // Get current time up to the hour (excluding minutes/seconds for prompt cache optimization)
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hour = String(now.getUTCHours()).padStart(2, '0');
  const currentTime = `${year}-${month}-${day}T${hour}:00:00Z`;

  // Define Markdown rendering rules in English
  const markdownRules = `    This system supports the following Markdown formats:
    - Mermaid diagram notation (\`\`\`mermaid ... \`\`\`)
    - LaTeX math notation (inline: $...$, block: $$...$$)
    - Image: ![alt](https://xxx.s3.us-east-1.amazonaws.com/<presignedUrl>)`;

  // Check if S3-related tools are enabled
  const s3ToolNames: readonly string[] = [RUNTIME_TOOL_NAMES.S3_LIST_FILES];
  const enabledS3Tools = tools.filter((tool) => s3ToolNames.includes(tool.name));
  const hasS3Tools = enabledS3Tools.length > 0;

  // Add section only if S3 storage tools are enabled
  let userStorageSection = '';
  if (hasS3Tools) {
    const enabledToolsList = enabledS3Tools.map((t) => `    - ${t.name}`).join('\n');
    userStorageSection = `

  ## About File Output
  - You are running on AWS Bedrock AgentCore. Therefore, when writing files, always write them under ${WORKSPACE_DIR}.
  - Similarly, if you need a workspace, please use the ${WORKSPACE_DIR} directory. Do not ask the user about their current workspace. It's always ${WORKSPACE_DIR}.
  - Also, users cannot directly access files written under ${WORKSPACE_DIR}. So when submitting these files to users, *always upload them to S3 using the s3_upload_file tool and provide the S3 URL*. The S3 URL must be included in the final output.
  - If the output file is an image file, the S3 URL output must be in Markdown format.
  - Note: When uploading files with Japanese or non-ASCII characters, specify contentType with charset (e.g., "text/plain; charset=utf-8") to ensure proper encoding.

  <user_storage>
    <description>
      You have access to a dedicated personal S3 storage space for this user.
      This storage is isolated per user and persists across conversations.
    </description>
    <enabled_tools>
${enabledToolsList}
    </enabled_tools>
    <usage_guidelines>
      - All paths are relative to user's root (e.g., "/code/app.py", "/docs/report.md")
      - Organize files logically using directories (e.g., /code/, /notes/, /data/)
      - Presigned URLs are valid for 1 hour by default and can be shared externally
      - For large files or binary content, prefer presigned URLs over inline content
    </usage_guidelines>
  </user_storage>`;
  }

  // Check if the Think tool is enabled
  const hasThinkTool = tools.some((tool) => tool.name === RUNTIME_TOOL_NAMES.THINK);

  let thinkToolSection = '';
  if (hasThinkTool) {
    thinkToolSection = `

  ## Thinking Tool

  You have access to a \`think\` tool. Use it to reason through complex situations BEFORE taking action:

  - **After receiving tool results**: Analyze what the results mean before making the next tool call
  - **When facing ambiguous requests**: Think through the user's intent before proceeding
  - **For multi-step planning**: Plan your approach before executing a sequence of actions
  - **When deciding between approaches**: Evaluate trade-offs before committing to one path
  - **Before critical operations**: Verify your reasoning before executing destructive or irreversible actions

  You do NOT need to use \`think\` for simple, straightforward tasks.`;
  }

  return `
<context>
  <current_time>${currentTime}</current_time>
  <markdown_rules>
${markdownRules}
  </markdown_rules>${userStorageSection}${thinkToolSection}
  <tool_execution_guidelines>
    When performing file creation or editing tasks, split large content across
    multiple tool calls rather than generating everything in a single response.
    Keep inline response text concise — write detailed content to files via tools
    instead of printing large blocks in the chat response.
    For multi-step tasks, execute one step at a time and confirm each step before proceeding.
  </tool_execution_guidelines>
</context>`;
}

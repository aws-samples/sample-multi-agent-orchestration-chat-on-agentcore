import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

const fileContentSchema = z.object({
  path: z.string(),
  text: z.string(),
});

const codeInterpreterSchema = z.object({
  // Action type (required)
  action: z
    .enum([
      'initSession',
      'executeCode',
      'executeCommand',
      'readFiles',
      'listFiles',
      'removeFiles',
      'writeFiles',
      'downloadFiles',
      'listLocalSessions',
    ])
    .describe(
      'The operation type to perform. Must be one of: initSession (create new session), executeCode (run code), executeCommand (run shell command), readFiles (read file contents), listFiles (list directory), removeFiles (delete files), writeFiles (create/update files), downloadFiles (download to local), listLocalSessions (list all sessions)'
    ),

  // Common parameters
  sessionName: z
    .string()
    .describe(
      'Session name for the code execution environment. REQUIRED for all operations except listLocalSessions. Use initSession first to create a session, then specify that session name for subsequent operations to maintain context and file persistence.'
    ),

  // For initSession only
  description: z
    .string()
    .optional()
    .describe(
      'Session description (REQUIRED for initSession action). Describes the purpose of this code execution session.'
    ),

  // For executeCode only
  language: z
    .enum(['python', 'javascript', 'typescript'])
    .optional()
    .describe(
      'Programming language (REQUIRED for executeCode action). Supported languages: python (with data science packages), javascript (Node.js), typescript (Node.js with TypeScript support)'
    ),
  code: z
    .string()
    .optional()
    .describe(
      'Source code to execute (REQUIRED for executeCode action). Can be multi-line code with full program logic.'
    ),
  clearContext: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Clear session context before execution (optional for executeCode). Set to true to start with fresh environment, false to preserve variables and state.'
    ),

  // For executeCommand only
  command: z
    .string()
    .optional()
    .describe(
      'Shell command to execute (REQUIRED for executeCommand action). Can include pipes, redirects, and command chaining.'
    ),

  // Common for readFiles / removeFiles
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Array of file paths (REQUIRED for readFiles and removeFiles actions). Paths are relative to session working directory.'
    ),

  // For listFiles only
  path: z
    .string()
    .optional()
    .describe(
      'Directory path to list (REQUIRED for listFiles action). Use "/" for root of sandbox, or relative paths.'
    ),

  // For writeFiles only
  content: z
    .array(fileContentSchema)
    .optional()
    .describe(
      'Array of file objects with path and text properties (REQUIRED for writeFiles action). Each object must have {path: string, text: string}. Creates or overwrites files.'
    ),

  // For downloadFiles only
  sourcePaths: z
    .array(z.string())
    .optional()
    .describe(
      'Array of source file paths in sandbox (REQUIRED for downloadFiles action). Files to download from the code execution environment.'
    ),
  destinationDir: z
    .string()
    .optional()
    .describe(
      'Absolute local filesystem path for downloads (REQUIRED for downloadFiles action). Use /tmp/ws or subdirectories like /tmp/ws/downloads for automatic S3 synchronization. Files downloaded to other paths (e.g., /tmp/downloads, /Users/xxx) will NOT be synced to S3 storage.'
    ),
});

export const codeInterpreterDefinition: ToolDefinition<typeof codeInterpreterSchema> = {
  name: 'code_interpreter',
  description: `Code Interpreter tool for executing code in isolated sandbox environments.

This tool provides a comprehensive code execution platform that supports multiple programming languages with persistent session management, file operations, and shell command execution. Built on Amazon Bedrock AgentCore Code Sandbox, it offers secure, isolated environments for code execution with full lifecycle management.

KEY FEATURES:

1. Multi-Language Support:
   • Python: Full standard library + data science packages (pandas, numpy, matplotlib, etc.)
   • JavaScript/TypeScript: Node.js runtime with common packages
   • Shell commands: Execute system commands and scripts

2. Session Management:
   • Create named, persistent sessions for stateful code execution
   • Automatic session creation when session_name is omitted
   • Session isolation for security and resource separation
   • Sessions persist across multiple tool calls

3. File System Operations:
   • Read, write, list, and remove files in the sandbox
   • Multi-file operations in a single request
   • Download files from sandbox to local filesystem

4. Advanced Execution:
   • Context preservation across executions within sessions
   • Optional context clearing for fresh environments
   • Real-time output capture and error handling
   • Support for long-running processes (up to 8 hours)

OPERATION TYPES:

1. initSession - Create a new isolated code execution session
   Required: description
   Optional: session_name (auto-generated if omitted)

2. executeCode - Run code in a specified programming language
   Required: language, code
   Optional: session_name, clearContext
   Languages: python | javascript | typescript

3. executeCommand - Execute shell commands in the sandbox
   Required: command
   Optional: session_name

4. readFiles - Read file contents from the sandbox
   Required: paths (array of file paths)
   Optional: session_name

5. writeFiles - Create or update files in the sandbox
   Required: content (array of {path, text} objects)
   Optional: session_name

6. listFiles - Browse directory contents
   Required: path (directory to list)
   Optional: session_name

7. removeFiles - Delete files from the sandbox
   Required: paths (array of file paths)
   Optional: session_name

8. downloadFiles - Download files to local filesystem
   Required: sourcePaths (array), destinationDir (absolute path)
   Optional: session_name

9. listLocalSessions - View all active sessions

FILE SYSTEM STRUCTURE:

⚠️ CRITICAL: Two Separate File Systems

CodeInterpreter uses TWO DIFFERENT file systems that DO NOT share files:

1. CODE EXECUTION FILE SYSTEM (executeCode/executeCommand):
   • Working Directory: /opt/amazon/genesis1p-tools/var
   • Files created by Python/JavaScript code live here
   • Files created by shell commands live here
   • These files CANNOT be accessed by readFiles
   
   Access methods:
   ✓ executeCode: Print file contents
   ✓ executeCommand: cat filename
   ✓ downloadFiles: Download to local filesystem

2. MCP RESOURCE FILE SYSTEM (writeFiles/readFiles/listFiles):
   • Virtual file system with URI format: file:///filename
   • ONLY files created by writeFiles can be read by readFiles
   • Files from executeCode are NOT visible here
   
   Access methods:
   ✓ writeFiles: Create files
   ✓ readFiles: Read files (ONLY those created by writeFiles)
   ✓ listFiles: Browse files (ONLY shows writeFiles-created files)
   ✓ removeFiles: Delete files

• File Path Examples:
  For executeCode/executeCommand:
    ✓ GOOD: "sales_data.csv" (relative to /opt/amazon/genesis1p-tools/var)
    ✓ GOOD: "/opt/amazon/genesis1p-tools/var/output.png"
  
  For writeFiles/readFiles:
    ✓ GOOD: "report.txt" (creates file:///report.txt)
    ✓ GOOD: "data/results.csv" (creates file:///data/results.csv)

⚠️ Common Mistake:
{
  "action": "executeCode",
  "code": "import pandas as pd\ndf.to_csv('data.csv')"
}
// Then trying to read it:
{
  "action": "readFiles",
  "paths": ["data.csv"]  // ❌ FAILS: File not found!
}

✓ Correct approach - Use downloadFiles:
{
  "action": "downloadFiles",
  "sourcePaths": ["data.csv"],
  "destinationDir": "/tmp/downloads"
}

✓ Or read directly in executeCode:
{
  "action": "executeCode",
  "code": "with open('data.csv', 'r') as f:\n    print(f.read())"
}

SESSION MANAGEMENT - DETAILED BEHAVIOR:

⚠️ CRITICAL: Context Preservation Issues
• Variables may not persist between executeCode calls even within the same session
• For reliable multi-step workflows, combine operations in single executeCode block
• Always verify variable existence before use

PACKAGE AVAILABILITY WARNING:

⚠️ Common packages that are NOT pre-installed and will cause ImportError:
• seaborn (use matplotlib.pyplot instead for statistical plots)
• scikit-learn (install via: pip install scikit-learn)
• tensorflow / pytorch (install via: pip install tensorflow or pip install torch)
• plotly / altair (install via: pip install plotly or pip install altair)

✓ How to install additional packages:
{
  "action": "executeCommand",
  "sessionName": "your-session",
  "command": "pip install seaborn scikit-learn"
}

✓ Alternative visualization approaches (without seaborn):
• Histograms: plt.hist(data, bins=20)
• Bar charts: plt.bar(categories, values)
• Scatter plots: plt.scatter(x, y)
• Box plots: plt.boxplot(data)
• Heatmaps: plt.imshow(data, cmap='viridis'); plt.colorbar()

Example - Creating statistical plots with matplotlib only:
import matplotlib.pyplot as plt
import numpy as np

# Distribution plot (seaborn alternative)
plt.figure(figsize=(10, 6))
plt.hist(data, bins=30, alpha=0.7, edgecolor='black')
plt.xlabel('Value')
plt.ylabel('Frequency')
plt.title('Distribution Plot')
plt.savefig('/tmp/ws/distribution.png')

RECOMMENDED PATTERNS:

✓ BEST: Single executeCode block for related operations
{
  "action": "executeCode",
  "sessionName": "analysis",
  "code": "import pandas as pd\ndf = pd.read_csv('data.csv')\nresult = df.describe()\nprint(result)"
}

⚠️ RISKY: Multiple executeCode calls expecting variable persistence
Step 1: df = pd.read_csv('data.csv')
Step 2: print(df.describe())  # df may not exist!

✓ WORKAROUND: Save intermediate results to files
Step 1: df.to_csv('/tmp/ws/temp.csv')
Step 2: df = pd.read_csv('/tmp/ws/temp.csv')  

BINARY FILE HANDLING:

⚠️ LIMITATION: writeFiles only supports text content
• Cannot directly upload binary files (images, PDFs, etc.) via writeFiles
• Binary files must be created within the sandbox using code

WORKFLOW FOR IMAGES/BINARY FILES:

Step 1: Generate file in sandbox
{
  "action": "executeCode",
  "language": "python",
  "code": "import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.savefig('/tmp/ws/chart.png')"
}

Step 2: Files remain in sandbox
• Image is saved in /tmp/ws/chart.png
• Cannot be directly uploaded to S3 via writeFiles
• Use downloadFiles or external S3 upload tools

Note: The sandbox filesystem is ephemeral - files are lost when session ends

COMMON USAGE SCENARIOS:

✓ Data Analysis: Execute Python for data processing and visualization
✓ Web Development: Run JavaScript/TypeScript for frontend/backend tasks
✓ System Administration: Execute shell commands for environment setup
✓ File Processing: Read, transform, and write files programmatically
✓ API Testing: Run code to test external services
✓ Educational Coding: Provide safe learning environments

USAGE PATTERNS:

GOOD Pattern - Simple one-off execution (no session management needed):
{
  "action": "executeCode",
  "language": "python",
  "code": "print('Hello World')"
}

GOOD Pattern - Multi-step workflow with named session:
Step 1: Create session
{
  "action": "initSession",
  "sessionName": "data-analysis",
  "description": "Customer data analysis"
}

Step 2: Upload data
{
  "action": "writeFiles",
  "sessionName": "data-analysis",
  "content": [
    {"path": "data.csv", "text": "id,name,value\\n1,Alice,100"}
  ]
}

Step 3: Process data
{
  "action": "executeCode",
  "sessionName": "data-analysis",
  "language": "python",
  "code": "import pandas as pd\\ndf = pd.read_csv('data.csv')\\nprint(df.describe())"
}

Step 4: Download results
{
  "action": "downloadFiles",
  "sessionName": "data-analysis",
  "sourcePaths": ["results.png", "summary.csv"],
  "destinationDir": "/tmp/analysis-results"
}

GOOD Pattern - Data visualization workflow:
{
  "action": "executeCode",
  "language": "python",
  "code": "import matplotlib.pyplot as plt\\nimport numpy as np\\n\\nx = np.linspace(0, 10, 100)\\ny = np.sin(x)\\n\\nplt.figure(figsize=(10, 6))\\nplt.plot(x, y)\\nplt.title('Sin Wave')\\nplt.savefig('plot.png')\\nprint('Plot saved')"
}

GOOD Pattern - Environment setup with shell commands:
{
  "action": "executeCommand",
  "command": "pip install requests && python -c \\"import requests; print(requests.__version__)\\""
}

BAD Pattern - Forgetting to specify required action:
{
  "language": "python",
  "code": "print('test')"
}
→ Error: Missing required 'action' field

BAD Pattern - Using invalid language:
{
  "action": "executeCode",
  "language": "ruby",
  "code": "puts 'test'"
}
→ Error: Invalid language. Must be: python, javascript, or typescript

BAD Pattern - Relative path for download destination:
{
  "action": "downloadFiles",
  "sourcePaths": ["file.txt"],
  "destinationDir": "./downloads"
}
→ Error: destinationDir must be absolute path

BAD Pattern - Forgetting paths array for file operations:
{
  "action": "readFiles",
  "path": "file.txt"
}
→ Error: 'paths' must be an array, not a string

IMPORTANT NOTES:

• Session names must be unique per user/conversation for proper isolation
• Context is preserved within sessions unless clearContext=true
• File paths in sandbox are relative to session working directory (/)
• Downloaded files use absolute local paths
• Shell commands execute in bash environment
• Maximum file size: 100MB inline, 5GB via S3
• Session timeout: 15 minutes default, up to 8 hours maximum

TIPS FOR BEST RESULTS:

1. Use descriptive session names for complex workflows
2. Clear context when starting fresh analysis in same session
3. Check file existence before reading with listFiles
4. Use writeFiles to prepare data before code execution
5. Download important results before session cleanup
6. Handle errors gracefully - check status field in responses
7. Use shell commands for system operations (pip install, etc.)`,
  zodSchema: codeInterpreterSchema,
  jsonSchema: zodToJsonSchema(codeInterpreterSchema),
};

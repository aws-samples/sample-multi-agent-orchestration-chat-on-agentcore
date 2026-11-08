import { pegasusVideoToTextTool } from './pegasus-video-to-text.js';

const liveTest = process.env.RUN_PEGASUS_INTEGRATION === '1' ? test : test.skip;

liveTest(
  'analyzes an explicitly supplied workspace video against Bedrock',
  async () => {
    const videoPath = process.env.PEGASUS_TEST_VIDEO_URI;
    const identityId = process.env.PEGASUS_TEST_IDENTITY_ID;
    const storagePath = process.env.PEGASUS_TEST_STORAGE_PATH;
    if (!videoPath || !identityId || !storagePath) {
      throw new Error(
        'Set PEGASUS_TEST_VIDEO_URI, PEGASUS_TEST_IDENTITY_ID and PEGASUS_TEST_STORAGE_PATH'
      );
    }
    const result = await pegasusVideoToTextTool.handler({
      videoPath,
      prompt: 'Describe this video briefly.',
      maxOutputTokens: 512,
      _context: { identityId, storagePath },
    });
    expect(result.success).toBe(true);
    expect(['stop', 'length']).toContain(result.stopReason);
    expect(typeof result.message).toBe('string');
  },
  900000
);

# Pegasus video analysis

The Gateway target stack deploys `pegasus-tools` alongside Nova Reel. Enable
`pegasus-tools___video_to_text` in an agent's `enabledTools` to use it; existing
agent defaults are unchanged. Deployment alone does not invoke the model.

Before invoking, enable account access to TwelveLabs Pegasus 1.5 in Amazon Bedrock
(including its AWS Marketplace subscription). Model calls incur provider charges.
The target invokes from `us-east-1` using the global inference profile by default;
this routes video data across Regions. The optional `modelId` input selects the US
geographic profile instead. Check your organization's data-residency requirements.
See the [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-twelvelabs-pegasus-v1-5.html).

Videos must already be uploaded/synced to the current workspace. A relative path
or `/tmp/ws/` path is resolved in S3, not opened on the Lambda filesystem. This
small-file path is limited to 25 MiB; larger videos must use the full workspace S3
URI (the service limit is less than 2 GB and up to two hours). `_context` is not a
tool input: the Gateway interceptor supplies identity and workspace scope.

The current implementation uses synchronous InvokeModel, not streaming or async
jobs. Long videos may exceed Gateway/client timeouts even though the Lambda has a
15-minute timeout; use short videos for this first version. `stopReason: length`
means output was truncated, not that analysis was complete. The returned fields
include `message`, `stopReason`, and segmentation fields when present.

No new S3 bucket policy or KMS grant is installed. The standard user-storage bucket
uses S3-managed encryption. Custom CMK-encrypted storage requires a separately
reviewed key-policy and execution-role grant; do not broaden the bucket policy.

Offline checks:

```sh
npm run test -w @moca/lambda-tools-pegasus -- --runInBand
npm run test -w @moca/cdk -- --runInBand
```

Before production use, perform an opt-in live check with a non-sensitive video in
your own workspace, verify the analysis and `stopReason`, and confirm a different
user's S3 URI is rejected. Live invocation and deployment are not part of these tests.

The live test is skipped by default. To explicitly enable a paid invocation, set
`RUN_PEGASUS_INTEGRATION=1`, `PEGASUS_TEST_VIDEO_URI`,
`PEGASUS_TEST_IDENTITY_ID`, `PEGASUS_TEST_STORAGE_PATH`,
`USER_STORAGE_BUCKET_NAME`, and `USER_STORAGE_BUCKET_OWNER`, then run the Pegasus
test command above with AWS credentials authorized for that workspace and model.

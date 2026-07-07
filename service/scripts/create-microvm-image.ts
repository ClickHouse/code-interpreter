/**
 * Create (or update) a hookless Lambda MicroVM image for the CodeAPI runner and
 * poll it to CREATED. This is the one provisioning step Terraform can't own yet
 * (the lambda-microvms service has no TF resource), so it lives here as a thin,
 * guaranteed-correct wrapper over the SDK call proven during the spike.
 *
 * Hookless by design: Lambda's image build hooks only route on the
 * snapshot-compatible Lambda base *container* image, and enabling any runtime
 * hook forces the /ready build hook (which never reaches a stock container's
 * listener, so the build fails at the ready timeout). Session mode is delivered
 * per request via the X-Runtime-Session-Id header instead — no hooks needed.
 *
 * Run from the service workspace so the SDK resolves:
 *   cd service && AWS_PROFILE=... bun scripts/create-microvm-image.ts \
 *     --name codeapi-session \
 *     --artifact s3://<artifact-bucket>/runner/runner-<tag>.zip \
 *     --build-role arn:aws:iam::<acct>:role/codeapi-microvm-build \
 *     --region us-east-1
 *
 * Flags (or the UPPER_SNAKE env equivalents):
 *   --name          MICROVM_IMAGE_NAME     image name (default codeapi-session)
 *   --artifact      MICROVM_ARTIFACT_URI   s3:// uri of the code-artifact zip (required)
 *   --build-role    MICROVM_BUILD_ROLE_ARN build role arn (required)
 *   --base-image    MICROVM_BASE_IMAGE_ARN default arn:aws:lambda:<region>:aws:microvm-image:al2023-1
 *   --region        MICROVM_REGION         default us-east-1
 *   --memory        MICROVM_MEMORY_MIB     baseline memory (default 2048)
 *   --update        MICROVM_UPDATE=true    update an existing image (new version) instead of create
 */
import {
  LambdaMicrovmsClient,
  CreateMicrovmImageCommand,
  UpdateMicrovmImageCommand,
  GetMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';

function arg(flag: string, env: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[env] ?? fallback;
}

const region = arg('--region', 'MICROVM_REGION', 'us-east-1') as string;
const name = arg('--name', 'MICROVM_IMAGE_NAME', 'codeapi-session') as string;
const artifactUri = arg('--artifact', 'MICROVM_ARTIFACT_URI');
const buildRoleArn = arg('--build-role', 'MICROVM_BUILD_ROLE_ARN');
const baseImageArn = arg(
  '--base-image',
  'MICROVM_BASE_IMAGE_ARN',
  `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`,
) as string;
const memory = Number(arg('--memory', 'MICROVM_MEMORY_MIB', '2048'));
const isUpdate = (arg('--update', 'MICROVM_UPDATE') ?? 'false') === 'true' || process.argv.includes('--update');

if (!artifactUri || !buildRoleArn) {
  console.error('Missing required --artifact <s3://...> and/or --build-role <arn>.');
  process.exit(2);
}

/* Runner env is baked at image-build time (RunMicrovm does not inject it later),
 * so the runner needs its file-server / egress-gateway / manifest config HERE or
 * it builds invalid `/sessions/...` URLs and can't fetch inputs or upload
 * outputs. The helper can't know your deployment's URLs, so pass them via
 * --env-json '{"FILE_SERVER_URL":"...","EGRESS_GATEWAY_URL":"...", ...}' (or the
 * MICROVM_IMAGE_ENV_JSON env). Typical keys: FILE_SERVER_URL, EGRESS_GATEWAY_URL,
 * SANDBOX_ALLOWED_LOCAL_NETWORK_PORT, SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY,
 * SANDBOX_REQUIRE_EGRESS_MANIFEST, REQUIRE_EXECUTION_MANIFEST. */
function parseEnvJson(): Record<string, string> {
  const raw = arg('--env-json', 'MICROVM_IMAGE_ENV_JSON');
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
}

/* Hard-won working image config (see docs/lambda-microvm/README.md):
 *  - additionalOsCapabilities ["ALL"]: nsjail needs CAP_SYS_ADMIN for its /proc
 *    mount inside the guest, else EPERM.
 *  - SANDBOX_USE_CGROUPV2=false: the app container can't read the cgroup v2
 *    subtree_control, so fall back to rlimit-based caps.
 *  - NO hooks: hookless is the reliable build path (see header). */
const shared = {
  baseImageArn,
  buildRoleArn,
  codeArtifact: { uri: artifactUri },
  cpuConfigurations: [{ architecture: 'ARM_64' as const }],
  resources: [{ minimumMemoryInMiB: memory }],
  additionalOsCapabilities: ['ALL' as const],
  environmentVariables: { SANDBOX_USE_CGROUPV2: 'false', ...parseEnvJson() },
};

const client = new LambdaMicrovmsClient({ region, retryMode: 'adaptive', maxAttempts: 3 });

async function main(): Promise<void> {
  console.log(`${isUpdate ? 'Updating' : 'Creating'} hookless MicroVM image "${name}" in ${region}...`);
  if (isUpdate) {
    await client.send(new UpdateMicrovmImageCommand({ imageIdentifier: name, ...shared } as never));
  } else {
    await client.send(new CreateMicrovmImageCommand({ name, description: 'CodeAPI hookless session runner', ...shared } as never));
  }

  const started = Date.now();
  /* Cap the wait so a build wedged in CREATING/UPDATING can't hang a
   * provisioning job forever (observed during the spike). Override with
   * MICROVM_BUILD_DEADLINE_MINUTES. */
  const deadlineMs = started + Number(process.env.MICROVM_BUILD_DEADLINE_MINUTES ?? '30') * 60_000;
  for (;;) {
    /* GetMicrovmImage accepts the image name as the identifier. */
    const img = (await client.send(
      new GetMicrovmImageCommand({ imageIdentifier: name }),
    )) as { state?: string; imageArn?: string; imageVersion?: string; stateReason?: string };
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (Date.now() > deadlineMs) {
      console.error(`\nTimed out after ${elapsed}s still in state ${img.state ?? 'UNKNOWN'}. Check the build log group.`);
      process.exit(1);
    }
    const state = img.state ?? 'UNKNOWN';
    if (state === 'CREATED' || state === 'UPDATED') {
      console.log(`\n${state} in ${elapsed}s`);
      console.log(`  imageArn: ${img.imageArn}`);
      console.log(`  version:  ${img.imageVersion ?? '(latest)'}`);
      console.log('\nSet on the CodeAPI service:');
      console.log(`  LAMBDA_MICROVM_IMAGE_ARN=${img.imageArn}`);
      return;
    }
    if (state.includes('FAILED')) {
      console.error(`\n${state} after ${elapsed}s. reason: ${img.stateReason || '(empty — check the build log group)'}`);
      process.exit(1);
    }
    if (elapsed % 60 < 20) console.log(`  [${elapsed}s] ${state}`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

main().catch((error) => {
  console.error('create-microvm-image failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

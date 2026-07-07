import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  GetMicrovmCommand,
  SuspendMicrovmCommand,
  ResumeMicrovmCommand,
  TerminateMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
  type MicrovmState,
} from '@aws-sdk/client-lambda-microvms';
import {
  LambdaMicrovmApiError,
  MICROVM_AUTH_HEADER,
  type LambdaMicrovmClient,
  type LambdaMicrovmErrorKind,
  type MicrovmAuthToken,
  type MicrovmDescription,
  type MicrovmLifecycleState,
  type RunMicrovmArgs,
} from './lambda-client';

const THROTTLE_ERROR_NAMES = new Set(['ThrottlingException', 'TooManyRequestsException']);

const ERROR_KIND_BY_NAME: Record<string, LambdaMicrovmErrorKind> = {
  ResourceNotFoundException: 'not_found',
  ConflictException: 'conflict',
  ResourceConflictException: 'conflict',
  ServiceQuotaExceededException: 'quota_exceeded',
  ValidationException: 'validation',
  InvalidParameterValueException: 'validation',
};

function classifyError(error: unknown): LambdaMicrovmErrorKind {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (THROTTLE_ERROR_NAMES.has(name)) return 'throttled';
  return ERROR_KIND_BY_NAME[name] ?? 'other';
}

function toDescription(response: {
  microvmId?: string;
  state?: MicrovmState;
  endpoint?: string;
  imageArn?: string;
  imageVersion?: string;
  maximumDurationInSeconds?: number;
  startedAt?: Date;
  stateReason?: string;
}): MicrovmDescription {
  /* Every command (Run/Get/Suspend/Resume/Terminate) returns the VM id. A
   * missing id means a partial/garbled response; fail fast rather than hand
   * back `''`, which downstream getMicrovm('')/terminateMicrovm('') would act
   * on — leaking the just-created VM as orphaned and billable. */
  if (response.microvmId == null || response.microvmId === '') {
    throw new Error('Lambda MicroVM response omitted microvmId');
  }
  return {
    microvmId: response.microvmId,
    state: (response.state ?? 'PENDING') as MicrovmLifecycleState,
    endpoint: response.endpoint,
    imageArn: response.imageArn,
    imageVersion: response.imageVersion,
    maximumDurationSeconds: response.maximumDurationInSeconds,
    startedAtMs: response.startedAt?.getTime(),
    stateReason: response.stateReason,
  };
}

/** Minimal send-shaped surface so tests can stub the SDK client. */
export interface MicrovmCommandSender {
  send(command: unknown): Promise<unknown>;
}

export class AwsLambdaMicrovmClient implements LambdaMicrovmClient {
  private readonly client: MicrovmCommandSender;

  constructor(options: { region?: string; client?: MicrovmCommandSender } = {}) {
    this.client = options.client ?? new LambdaMicrovmsClient({
      region: options.region,
      retryMode: 'adaptive',
      maxAttempts: 3,
    });
  }

  private async send<T>(operation: string, command: unknown): Promise<T> {
    try {
      return await this.client.send(command) as T;
    } catch (error) {
      throw new LambdaMicrovmApiError(
        classifyError(error),
        operation,
        (error as Error)?.message ?? `Lambda MicroVM ${operation} failed`,
        error,
      );
    }
  }

  async runMicrovm(args: RunMicrovmArgs): Promise<MicrovmDescription> {
    const response = await this.send<Parameters<typeof toDescription>[0]>('RunMicrovm', new RunMicrovmCommand({
      imageIdentifier: args.imageIdentifier,
      imageVersion: args.imageVersion,
      executionRoleArn: args.executionRoleArn,
      ingressNetworkConnectors: args.ingressConnectorArns,
      egressNetworkConnectors: args.egressConnectorArns,
      maximumDurationInSeconds: args.maximumDurationSeconds,
      idlePolicy: args.idlePolicy
        ? {
          maxIdleDurationSeconds: args.idlePolicy.maxIdleSeconds,
          suspendedDurationSeconds: args.idlePolicy.suspendedSeconds,
          autoResumeEnabled: args.idlePolicy.autoResume,
        }
        : undefined,
      logging: args.logGroup ? { cloudWatch: { logGroup: args.logGroup } } : undefined,
      runHookPayload: args.runHookPayload,
      clientToken: args.clientToken,
    }));
    return toDescription(response);
  }

  async getMicrovm(microvmId: string): Promise<MicrovmDescription> {
    const response = await this.send<Parameters<typeof toDescription>[0]>(
      'GetMicrovm',
      new GetMicrovmCommand({ microvmIdentifier: microvmId }),
    );
    return toDescription(response);
  }

  async suspendMicrovm(microvmId: string): Promise<void> {
    await this.send('SuspendMicrovm', new SuspendMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  async resumeMicrovm(microvmId: string): Promise<MicrovmDescription> {
    const response = await this.send<Parameters<typeof toDescription>[0]>(
      'ResumeMicrovm',
      new ResumeMicrovmCommand({ microvmIdentifier: microvmId }),
    );
    return toDescription(response);
  }

  async terminateMicrovm(microvmId: string): Promise<void> {
    await this.send('TerminateMicrovm', new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
  }

  async createMicrovmAuthToken(args: {
    microvmId: string;
    port: number;
    ttlSeconds: number;
  }): Promise<MicrovmAuthToken> {
    const expirationInMinutes = Math.min(Math.max(Math.ceil(args.ttlSeconds / 60), 1), 60);
    const response = await this.send<{ authToken?: Record<string, string> }>(
      'CreateMicrovmAuthToken',
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: args.microvmId,
        expirationInMinutes,
        allowedPorts: [{ port: args.port }],
      }),
    );
    const token = response.authToken?.[MICROVM_AUTH_HEADER];
    if (token == null || token.length === 0) {
      throw new LambdaMicrovmApiError(
        'other',
        'CreateMicrovmAuthToken',
        `CreateMicrovmAuthToken response missing ${MICROVM_AUTH_HEADER} entry`,
      );
    }
    return {
      headerName: MICROVM_AUTH_HEADER,
      token,
      expiresAtMs: Date.now() + expirationInMinutes * 60_000,
    };
  }
}

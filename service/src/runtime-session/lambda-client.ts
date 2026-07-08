/**
 * Thin, fakeable wrapper over the AWS Lambda MicroVM control plane.
 * `lambda-client-aws.ts` is the ONLY module allowed to import `@aws-sdk/*`;
 * everything else (backend, sweeper, tests) programs against this interface.
 */

export type MicrovmLifecycleState =
  | 'PENDING'
  | 'RUNNING'
  | 'SUSPENDING'
  | 'SUSPENDED'
  | 'TERMINATING'
  | 'TERMINATED';

export interface MicrovmDescription {
  microvmId: string;
  state: MicrovmLifecycleState;
  endpoint?: string;
  imageArn?: string;
  imageVersion?: string;
  maximumDurationSeconds?: number;
  startedAtMs?: number;
  stateReason?: string;
}

export interface MicrovmIdlePolicy {
  maxIdleSeconds: number;
  suspendedSeconds: number;
  autoResume: boolean;
}

export interface RunMicrovmArgs {
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  maximumDurationSeconds: number;
  idlePolicy?: MicrovmIdlePolicy;
  /** CloudWatch log group for the VM's stdout/stderr. Needs an executionRoleArn
   *  too, or the logs go nowhere. */
  logGroup?: string;
  /** Delivered verbatim as the /run lifecycle hook body (AWS cap: 16KB). */
  runHookPayload?: string;
  /** Idempotency token so a retried launch cannot double-provision. */
  clientToken?: string;
}

export interface MicrovmAuthToken {
  /** Header name the MicroVM proxy expects; AWS returns a map keyed by it. */
  headerName: string;
  token: string;
  expiresAtMs: number;
}

export type LambdaMicrovmErrorKind =
  | 'throttled'
  | 'not_found'
  | 'conflict'
  | 'quota_exceeded'
  | 'validation'
  | 'other';

export class LambdaMicrovmApiError extends Error {
  constructor(
    public readonly kind: LambdaMicrovmErrorKind,
    public readonly operation: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LambdaMicrovmApiError';
  }
}

export const MICROVM_AUTH_HEADER = 'X-aws-proxy-auth';

/** MicroVM endpoint traffic defaults to port 8080; to reach a different target
 *  port the request must carry this header (AWS routes to 8080 without it). */
export const MICROVM_PORT_HEADER = 'X-aws-proxy-port';
export const DEFAULT_MICROVM_PORT = 8080;

/** The port-routing header, only when the target port isn't the 8080 default. */
export function microvmPortHeaders(port: number): Record<string, string> {
  return port === DEFAULT_MICROVM_PORT ? {} : { [MICROVM_PORT_HEADER]: String(port) };
}

export interface LambdaMicrovmClient {
  runMicrovm(args: RunMicrovmArgs): Promise<MicrovmDescription>;
  getMicrovm(microvmId: string): Promise<MicrovmDescription>;
  suspendMicrovm(microvmId: string): Promise<void>;
  resumeMicrovm(microvmId: string): Promise<MicrovmDescription>;
  terminateMicrovm(microvmId: string): Promise<void>;
  createMicrovmAuthToken(args: {
    microvmId: string;
    port: number;
    ttlSeconds: number;
  }): Promise<MicrovmAuthToken>;
}

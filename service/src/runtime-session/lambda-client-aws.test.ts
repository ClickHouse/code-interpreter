import { describe, expect, test } from 'bun:test';
import { AwsLambdaMicrovmClient, type MicrovmCommandSender } from './lambda-client-aws';
import { LambdaMicrovmApiError, MICROVM_AUTH_HEADER } from './lambda-client';

type SentCommand = { constructor: { name: string }; input: Record<string, unknown> };

function stubSender(responses: unknown[]): { sender: MicrovmCommandSender; sent: SentCommand[] } {
  const sent: SentCommand[] = [];
  return {
    sent,
    sender: {
      send(command: unknown): Promise<unknown> {
        sent.push(command as SentCommand);
        const next = responses.shift();
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      },
    },
  };
}

function namedError(name: string): Error {
  const error = new Error(`${name} raised`);
  error.name = name;
  return error;
}

describe('AwsLambdaMicrovmClient command mapping', () => {
  test('runMicrovm maps args onto RunMicrovmCommand input and normalizes the response', async () => {
    const startedAt = new Date('2026-07-05T00:00:00Z');
    const { sender, sent } = stubSender([{
      microvmId: 'mvm-1',
      state: 'PENDING',
      endpoint: 'https://mvm-1.on.aws',
      imageArn: 'arn:aws:lambda:us-east-2:1:microvm-image/codeapi',
      imageVersion: '7',
      maximumDurationInSeconds: 28_800,
      startedAt,
    }]);
    const client = new AwsLambdaMicrovmClient({ client: sender });

    const description = await client.runMicrovm({
      imageIdentifier: 'arn:aws:lambda:us-east-2:1:microvm-image/codeapi',
      imageVersion: '7',
      executionRoleArn: 'arn:aws:iam::1:role/codeapi-microvm',
      ingressConnectorArns: ['arn:ingress'],
      egressConnectorArns: ['arn:egress'],
      maximumDurationSeconds: 28_800,
      idlePolicy: { maxIdleSeconds: 300, suspendedSeconds: 1_800, autoResume: true },
      runHookPayload: '{"runtime_session_id":"rt_x"}',
      clientToken: 'launch-rt_x-7',
    });

    expect(sent[0].constructor.name).toBe('RunMicrovmCommand');
    expect(sent[0].input).toEqual({
      imageIdentifier: 'arn:aws:lambda:us-east-2:1:microvm-image/codeapi',
      imageVersion: '7',
      executionRoleArn: 'arn:aws:iam::1:role/codeapi-microvm',
      ingressNetworkConnectors: ['arn:ingress'],
      egressNetworkConnectors: ['arn:egress'],
      maximumDurationInSeconds: 28_800,
      idlePolicy: {
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 1_800,
        autoResumeEnabled: true,
      },
      runHookPayload: '{"runtime_session_id":"rt_x"}',
      clientToken: 'launch-rt_x-7',
    });
    expect(description).toEqual({
      microvmId: 'mvm-1',
      state: 'PENDING',
      endpoint: 'https://mvm-1.on.aws',
      imageArn: 'arn:aws:lambda:us-east-2:1:microvm-image/codeapi',
      imageVersion: '7',
      maximumDurationSeconds: 28_800,
      startedAtMs: startedAt.getTime(),
      stateReason: undefined,
    });
  });

  test('lifecycle commands address the VM via microvmIdentifier', async () => {
    const { sender, sent } = stubSender([
      { microvmId: 'mvm-1', state: 'RUNNING' },
      {},
      { microvmId: 'mvm-1', state: 'RUNNING' },
      {},
    ]);
    const client = new AwsLambdaMicrovmClient({ client: sender });

    await client.getMicrovm('mvm-1');
    await client.suspendMicrovm('mvm-1');
    await client.resumeMicrovm('mvm-1');
    await client.terminateMicrovm('mvm-1');

    expect(sent.map((command) => command.constructor.name)).toEqual([
      'GetMicrovmCommand',
      'SuspendMicrovmCommand',
      'ResumeMicrovmCommand',
      'TerminateMicrovmCommand',
    ]);
    for (const command of sent) {
      expect(command.input).toEqual({ microvmIdentifier: 'mvm-1' });
    }
  });

  test('createMicrovmAuthToken clamps TTL to whole minutes and reads the header map', async () => {
    const { sender, sent } = stubSender([
      { authToken: { [MICROVM_AUTH_HEADER]: 'proxy-token-1' } },
    ]);
    const client = new AwsLambdaMicrovmClient({ client: sender });

    const token = await client.createMicrovmAuthToken({ microvmId: 'mvm-1', port: 8080, ttlSeconds: 300 });

    expect(sent[0].constructor.name).toBe('CreateMicrovmAuthTokenCommand');
    expect(sent[0].input).toEqual({
      microvmIdentifier: 'mvm-1',
      expirationInMinutes: 5,
      allowedPorts: [{ port: 8080 }],
    });
    expect(token.headerName).toBe(MICROVM_AUTH_HEADER);
    expect(token.token).toBe('proxy-token-1');
    expect(token.expiresAtMs).toBeGreaterThan(Date.now());
  });

  test('token TTL clamps to the 1..60 minute API bounds', async () => {
    const { sender, sent } = stubSender([
      { authToken: { [MICROVM_AUTH_HEADER]: 't1' } },
      { authToken: { [MICROVM_AUTH_HEADER]: 't2' } },
    ]);
    const client = new AwsLambdaMicrovmClient({ client: sender });

    await client.createMicrovmAuthToken({ microvmId: 'mvm-1', port: 8080, ttlSeconds: 10 });
    await client.createMicrovmAuthToken({ microvmId: 'mvm-1', port: 8080, ttlSeconds: 86_400 });

    expect((sent[0].input as { expirationInMinutes: number }).expirationInMinutes).toBe(1);
    expect((sent[1].input as { expirationInMinutes: number }).expirationInMinutes).toBe(60);
  });

  test('missing token entry in the response surfaces as an API error', async () => {
    const { sender } = stubSender([{ authToken: {} }]);
    const client = new AwsLambdaMicrovmClient({ client: sender });
    expect(client.createMicrovmAuthToken({ microvmId: 'mvm-1', port: 8080, ttlSeconds: 300 }))
      .rejects.toThrow(`missing ${MICROVM_AUTH_HEADER}`);
  });
});

describe('AwsLambdaMicrovmClient error classification', () => {
  const cases: Array<[string, string]> = [
    ['ThrottlingException', 'throttled'],
    ['TooManyRequestsException', 'throttled'],
    ['ResourceNotFoundException', 'not_found'],
    ['ConflictException', 'conflict'],
    ['ServiceQuotaExceededException', 'quota_exceeded'],
    ['ValidationException', 'validation'],
    ['SomeUnknownException', 'other'],
  ];

  for (const [name, kind] of cases) {
    test(`${name} -> ${kind}`, async () => {
      const { sender } = stubSender([namedError(name)]);
      const client = new AwsLambdaMicrovmClient({ client: sender });
      try {
        await client.getMicrovm('mvm-1');
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(LambdaMicrovmApiError);
        expect((error as LambdaMicrovmApiError).kind).toBe(kind as LambdaMicrovmApiError['kind']);
        expect((error as LambdaMicrovmApiError).operation).toBe('GetMicrovm');
      }
    });
  }
});

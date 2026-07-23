import { AwsLambdaMicrovmClient } from './runtime-session/lambda-client-aws';
import { probeInputs, pushInputs } from './runtime-session/checkpoint';
import { buildInputBatch } from './runtime-session/files';
import { normalizeMicrovmEndpoint } from './sandbox-backend/lambda-microvm';

const [microvmId, endpoint] = process.argv.slice(2);
const client = new AwsLambdaMicrovmClient({ region: 'us-east-1' });
const cfg = { port: 8080, authTokenTtlSeconds: 300, maxBytes: 512 * 1024 * 1024, timeoutMs: 30_000 };
const mintToken = () => client.createMicrovmAuthToken({ microvmId, port: 8080, ttlSeconds: 300 });
const base = normalizeMicrovmEndpoint(endpoint);
const refs = [{ storage_session_id: 'AP-6YQGnfCXsIbT1F00zs', id: 'V_WL-92AoQdSZWdN85fkt' }];

console.log('probe #1:', JSON.stringify(await probeInputs({ mintToken, endpointBase: base }, refs, cfg)));
const batch = await buildInputBatch(
  [{ storage_session_id: 'AP-6YQGnfCXsIbT1F00zs', id: 'V_WL-92AoQdSZWdN85fkt', name: 'probe.csv' }],
  { timeoutMs: 30_000, maxBytes: 1024 * 1024 },
);
console.log('batch bytes:', batch?.data.length);
await pushInputs({ mintToken, endpointBase: base }, batch!.data, cfg);
console.log('push: ok');
console.log('probe #2:', JSON.stringify(await probeInputs({ mintToken, endpointBase: base }, refs, cfg)));

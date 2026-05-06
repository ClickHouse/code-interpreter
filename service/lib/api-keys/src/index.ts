export * from './service';
export * from './models';
export * from './types';
import config from './config';
const PREFIX = config['PREFIX'];
const ENTERPRISE_PREFIX = config['ENTERPRISE_PREFIX'];
export { PREFIX, ENTERPRISE_PREFIX };

import { describe, expect, it } from 'vitest';
import { publicWebRuntime } from './public-runtime';

describe('public Web runtime settings', () => {
  it('uses deployment settings without rebuilding the Web bundle and excludes secrets', () => {
    expect(publicWebRuntime({
      REMI_WEB_LOCAL_PROFILE: 'stable', REMI_WEB_SITE_URL: 'http://192.0.2.1:13000',
      REMI_WEB_WS_URL: 'ws://192.0.2.1:16120/ws', REMI_APPLICATION_VERSION: '1.2.3',
      MULTIREMI_TOKEN: 'must-not-be-serialized', JWT_SECRET: 'must-not-be-serialized',
    })).toEqual({ localProfile: 'stable', siteUrl: 'http://192.0.2.1:13000', wsUrl: 'ws://192.0.2.1:16120/ws', apiUrl: undefined, version: '1.2.3' });
  });
});

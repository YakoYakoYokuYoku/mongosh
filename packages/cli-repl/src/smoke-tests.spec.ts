import { runSmokeTests } from './smoke-tests';
import path from 'path';
import { startTestServer, downloadCurrentCryptSharedLibrary } from '../../../testing/integration-testing-hooks';

describe('smoke tests', () => {
  const testServer = startTestServer('shared');
  let cryptLibrary: string;

  before(async() => {
    cryptLibrary = await downloadCurrentCryptSharedLibrary();
  });

  it('self-test passes', async() => {
    // Use ts-node to run the .ts files directly so nyc can pick them up for
    // coverage.
    await runSmokeTests(
      await testServer.connectionString(),
      process.execPath, '-r', 'ts-node/register', path.resolve(__dirname, 'run.ts'), '--cryptSharedLibPath', cryptLibrary
    );
  });
});

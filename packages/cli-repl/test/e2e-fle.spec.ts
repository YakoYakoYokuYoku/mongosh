import { expect } from 'chai';
import { MongoClient } from 'mongodb';
import { TestShell } from './test-shell';
import { eventually } from '../../../testing/eventually';
import {
  startTestServer,
  skipIfServerVersion,
  skipIfCommunityServer,
  downloadCurrentCryptSharedLibrary
} from '../../../testing/integration-testing-hooks';
import { makeFakeHTTPServer, fakeAWSHandlers } from '../../../testing/fake-kms';
import { once } from 'events';
import { serialize } from 'v8';
import { inspect } from 'util';
import path from 'path';
import os from 'os';

function isMacosTooOldForQE() {
  // Indexed search is not supported on macOS 10.14 (which in turn is
  // not supported by 6.0+ servers anyway).
  // See e.g. https://jira.mongodb.org/browse/MONGOCRYPT-440
  return os.type() === 'Darwin' && +os.release().split('.')[0] < 20;
}

describe('FLE tests', () => {
  const testServer = startTestServer('not-shared', '--replicaset', '--nodes', '1');
  skipIfServerVersion(testServer, '< 4.2'); // FLE only available on 4.2+
  skipIfCommunityServer(testServer); // FLE is enterprise-only
  let kmsServer: ReturnType<typeof makeFakeHTTPServer>;
  let dbname: string;
  let cryptLibrary: string;

  before(async function() {
    kmsServer = makeFakeHTTPServer(fakeAWSHandlers);
    kmsServer.listen(0);
    await once(kmsServer, 'listening');
    cryptLibrary = await downloadCurrentCryptSharedLibrary();
  });
  after(() => {
    // eslint-disable-next-line chai-friendly/no-unused-expressions
    kmsServer?.close();
  });
  beforeEach(() => {
    kmsServer.requests = [];
    dbname = `test-${Date.now()}`;
  });
  afterEach(async() => {
    const client = await MongoClient.connect(await testServer.connectionString(), {});
    await client.db(dbname).dropDatabase();
    await client.close();
  });
  afterEach(TestShell.cleanup);

  function* awsTestCases() {
    for (const useApiStrict of [ false, true ]) {
      for (const withSessionToken of [ false, true ]) {
        for (const withEnvVarCredentials of [ false, true ]) {
          yield {
            useApiStrict,
            withSessionToken,
            withEnvVarCredentials,
            testDescription: `with AWS KMS (apiStrict=${useApiStrict}, ` +
              `${withSessionToken ? 'with' : 'without'} sessionToken, ` +
              `${withEnvVarCredentials ? 'with' : 'without'} credentials in env vars)`
          };
        }
      }
    }
  }

  for (const {
    useApiStrict, withSessionToken, withEnvVarCredentials, testDescription
  } of awsTestCases()) {
    // eslint-disable-next-line no-loop-func
    context(testDescription, () => {
      if (useApiStrict) {
        skipIfServerVersion(testServer, '< 5.0');
      }

      const accessKeyId = 'SxHpYMUtB1CEVg9tX0N1';
      const secretAccessKey = '44mjXTk34uMUmORma3w1viIAx4RCUv78bzwDY0R7';
      const sessionToken = 'WXWHMnniSqij0CH27KK7H';
      async function makeTestShell(): Promise<TestShell> {
        const shell = TestShell.start({
          args: [
            `--cryptSharedLibPath=${cryptLibrary}`,
            ...(withEnvVarCredentials ? [] : [
              `--keyVaultNamespace=${dbname}.keyVault`,
              `--awsAccessKeyId=${accessKeyId}`,
              `--awsSecretAccessKey=${secretAccessKey}`,
              ...(withSessionToken ? [`--awsSessionToken=${sessionToken}`] : [])
            ]),
            ...(useApiStrict ? ['--apiStrict', '--apiVersion', '1'] : []),
            await testServer.connectionString()
          ],
          env: {
            ...process.env,
            NODE_OPTIONS: '--require ./redirect-network-io.js',
            REDIRECT_NETWORK_SOURCES: serialize(fakeAWSHandlers.map(({ host }) => host)).toString('base64'),
            REDIRECT_NETWORK_TARGET: `localhost:${(kmsServer.address() as any).port}`,
            ...(withEnvVarCredentials ? {
              AWS_ACCESS_KEY_ID: accessKeyId,
              AWS_SECRET_ACCESS_KEY: secretAccessKey,
              AWS_SESSION_TOKEN: withSessionToken ? sessionToken : undefined,
            } : {})
          },
          cwd: path.join(__dirname, 'fixtures')
        });

        if (withEnvVarCredentials) {
          // Need to set up the AWS context inside the shell for enabling
          // automatic encryption since there are no credentials on the command line
          // which would indicate that automatic encryption should be enabled
          await shell.executeLine(`db = new Mongo(db.getMongo(), {
            keyVaultNamespace: ${JSON.stringify(dbname + '.keyVault')},
            kmsProviders: { aws: {} }
          }).getDB(${JSON.stringify(dbname)})`);
        } else {
          await shell.executeLine(`use ${dbname}`);
        }

        return shell;
      }

      it('passes through command line options', async() => {
        const shell = await makeTestShell();
        await shell.executeLine(`db.keyVault.insertOne({
          _id: UUID("e7b4abe7-ff70-48c3-9d3a-3526e18c2646"),
          keyMaterial: new Binary(Buffer.from("010202007888b7b9089f9cf816059c4c02edf139d50227528b2a74a5c9910c89095d45a9d10133bd4c047f2ba610d7ad4efcc945f863000000c23081bf06092a864886f70d010706a081b13081ae0201003081a806092a864886f70d010701301e060960864801650304012e3011040cf406b9ccb00f83dd632e76e9020110807b9c2b3a676746e10486ec64468d45ec89cac30f59812b711fc24530188166c481f4f4ab376c258f8f54affdc8523468fdd07b84e77b21a14008a23fb6d111c05eb4287b7b973f3a60d5c7d87074119b424477366cbe72c31da8fc76b8f72e31f609c3b423c599d3e4a59c21e4a0fe227ebe1aa53038cb94f79c457b", "hex"), 0),
          creationDate: ISODate('2021-02-10T15:51:00.567Z'),
          updateDate: ISODate('2021-02-10T15:51:00.567Z'),
          status: 0,
          masterKey: {
            provider: 'aws',
            region: 'us-east-2',
            key: 'arn:aws:kms:us-east-2:398471984214:key/174b7c1d-3651-4517-7521-21988befd8cb'
          }
        })`);
        await shell.executeLine(`db.data.insertOne({
          _id: ObjectId("602400ec9933cbed7fa92a1c"),
          taxid: new Binary(Buffer.from("02e7b4abe7ff7048c39d3a3526e18c264602846f122fa8c1ae1b8aff3dc7c20a8a3dbc95541e8d0d75cb8daf0b7e3137d553a788ccb62e31fed2da98ea3a596972c6dc7c17bbe6f9a9edc3a7f3e2ad96a819", "hex"), 6)
        });`);
        // This will try to automatically decrypt the data, but it will not succeed.
        // That does not matter here -- we're just checking that the HTTP requests
        // made were successful.
        await eventually(async() => {
          await shell.executeLine('db.data.find();');
          shell.assertContainsError('MongoCryptError: decrypted key is incorrect length');
        });

        // The actual assertion here:
        if (!kmsServer.requests.some(req => req.headers.authorization.includes(accessKeyId)) ||
            (withSessionToken && !kmsServer.requests.some(req => req.headers['x-amz-security-token'] === sessionToken))) {
          throw new Error(`Missed expected request to AWS\nShell output:\n${shell.output}\nRequests:\n${kmsServer.requests.map(req => inspect(req.headers))}`);
        }
      });

      it('forwards command line options to the main Mongo instance', async() => {
        const shell = await makeTestShell();
        await shell.executeLine('keyId = db.getMongo().getKeyVault().createKey("aws", {' +
          'region: "us-east-2", key: "arn:aws:kms:us-east-2:398471984214:key/174b7c1d-3651-4517-7521-21988befd8cb" });');
        await shell.executeLine('clientEncryption = db.getMongo().getClientEncryption();');
        await shell.executeLine('encrypted = clientEncryption.encrypt(' +
          'keyId, { someValue: "foo" }, "AEAD_AES_256_CBC_HMAC_SHA_512-Random");');
        const result = await shell.executeLine('({ decrypted: clientEncryption.decrypt(encrypted) })');
        expect(result).to.include("{ decrypted: { someValue: 'foo' } }");
        shell.assertNoErrors();
      });
    });
  }

  it('works when the original shell was started with --nodb', async() => {
    const shell = TestShell.start({
      args: ['--nodb']
    });
    await shell.waitForPrompt();
    await shell.executeLine('local = { key: BinData(0, "kh4Gv2N8qopZQMQYMEtww/AkPsIrXNmEMxTrs3tUoTQZbZu4msdRUaR8U5fXD7A7QXYHcEvuu4WctJLoT+NvvV3eeIg3MD+K8H9SR794m/safgRHdIfy6PD+rFpvmFbY") }');
    await shell.executeLine(`keyMongo = Mongo(${JSON.stringify(await testServer.connectionString())}, { \
      keyVaultNamespace: '${dbname}.keyVault', \
      kmsProviders: { local }, \
      explicitEncryptionOnly: true \
    });`);
    await shell.executeLine('keyVault = keyMongo.getKeyVault();');
    const keyId = await shell.executeLine('keyId = keyVault.createKey("local");');
    const uuidRegexp = /UUID([^)])/;
    expect(keyId).to.match(uuidRegexp);
    await shell.executeLine(`plainMongo = Mongo(${JSON.stringify(await testServer.connectionString())})`);
    await shell.executeLine(`db = plainMongo.getDB('${dbname}')`);
    const keyVaultContents = await shell.executeLine('db.keyVault.find()');
    expect(keyVaultContents).to.include(keyId.match(uuidRegexp)[1]);
  });

  it('works when a schemaMap option has been passed', async() => {
    const shell = TestShell.start({
      args: ['--nodb', `--cryptSharedLibPath=${cryptLibrary}`]
    });
    await shell.waitForPrompt();
    await shell.executeLine('local = { key: BinData(0, "kh4Gv2N8qopZQMQYMEtww/AkPsIrXNmEMxTrs3tUoTQZbZu4msdRUaR8U5fXD7A7QXYHcEvuu4WctJLoT+NvvV3eeIg3MD+K8H9SR794m/safgRHdIfy6PD+rFpvmFbY") }');
    await shell.executeLine(`keyMongo = Mongo(${JSON.stringify(await testServer.connectionString())}, { \
      keyVaultNamespace: '${dbname}.keyVault', \
      kmsProviders: { local }, \
      schemaMap: {}, \
      encryptedFieldsMap: {} \
    });`);

    await shell.executeLine('keyVault = keyMongo.getKeyVault();');
    const keyId = await shell.executeLine('keyId = keyVault.createKey("local");');
    const uuidRegexp = /UUID([^)])/;
    expect(keyId).to.match(uuidRegexp);

    await shell.executeLine(`plainMongo = Mongo(${JSON.stringify(await testServer.connectionString())})`);
    await shell.executeLine(`db = plainMongo.getDB('${dbname}')`);
    const keyVaultContents = await shell.executeLine('db.keyVault.find()');
    expect(keyVaultContents).to.include(keyId.match(uuidRegexp)[1]);

    await shell.executeLine('clientEncryption = keyMongo.getClientEncryption();');
    await shell.executeLine('encrypted = clientEncryption.encrypt(' +
      'keyId, { someValue: "foo" }, "AEAD_AES_256_CBC_HMAC_SHA_512-Random");');
    const result = await shell.executeLine('({ decrypted: clientEncryption.decrypt(encrypted) })');
    expect(result).to.include("{ decrypted: { someValue: 'foo' } }");
  });

  it('skips automatic encryption when a bypassQueryAnalysis option has been passed', async() => {
    const shell = TestShell.start({
      args: ['--nodb', `--cryptSharedLibPath=${cryptLibrary}`]
    });
    const uri = JSON.stringify(await testServer.connectionString());

    await shell.waitForPrompt();

    await shell.executeLine('local = { key: BinData(0, "kh4Gv2N8qopZQMQYMEtww/AkPsIrXNmEMxTrs3tUoTQZbZu4msdRUaR8U5fXD7A7QXYHcEvuu4WctJLoT+NvvV3eeIg3MD+K8H9SR794m/safgRHdIfy6PD+rFpvmFbY") }');

    await shell.executeLine(`keyMongo = Mongo(${uri}, { \
      keyVaultNamespace: '${dbname}.keyVault', \
      kmsProviders: { local }, \
      bypassQueryAnalysis: true \
    });`);

    await shell.executeLine('keyVault = keyMongo.getKeyVault();');
    await shell.executeLine('keyId = keyVault.createKey("local");');

    await shell.executeLine(`schemaMap = { \
      '${dbname}.coll': { \
        bsonType: 'object', \
        properties: { \
          phoneNumber: { \
            encrypt: { \
              bsonType: 'string', \
              keyId: [keyId], \
              algorithm: 'AEAD_AES_256_CBC_HMAC_SHA_512-Random' \
            } \
          } \
        } \
      } \
    };`);

    await shell.executeLine(`autoMongo = Mongo(${uri}, { \
      keyVaultNamespace: '${dbname}.keyVault', \
      kmsProviders: { local }, \
      schemaMap \
    });`);

    await shell.executeLine(`bypassMongo = Mongo(${uri}, { \
      keyVaultNamespace: '${dbname}.keyVault', \
      kmsProviders: { local }, \
      bypassQueryAnalysis: true \
    });`);

    await shell.executeLine(`plainMongo = Mongo(${uri});`);

    await shell.executeLine(`autoMongo.getDB('${dbname}').coll.insertOne({ \
      phoneNumber: '+12874627836445' \
    });`);
    await shell.executeLine(`bypassMongo.getDB('${dbname}').coll.insertOne({
      phoneNumber: '+98173247931847'
    });`);

    const autoMongoResult = await shell.executeLine(`autoMongo.getDB('${dbname}').coll.find()`);
    expect(autoMongoResult).to.include("phoneNumber: '+12874627836445'");
    expect(autoMongoResult).to.include("phoneNumber: '+98173247931847'");

    const bypassMongoResult = await shell.executeLine(`bypassMongo.getDB('${dbname}').coll.find()`);
    expect(bypassMongoResult).to.include("phoneNumber: '+12874627836445'");
    expect(bypassMongoResult).to.include("phoneNumber: '+98173247931847'");

    const plainMongoResult = await shell.executeLine(`plainMongo.getDB('${dbname}').coll.find()`);
    expect(plainMongoResult).to.include("phoneNumber: '+98173247931847'");
    expect(plainMongoResult).to.include('phoneNumber: Binary(Buffer.from');
    expect(plainMongoResult).to.not.include("phoneNumber: '+12874627836445'");
  });

  it('does not allow compactStructuredEncryptionData command when mongo instance configured without auto encryption', async() => {
    const shell = TestShell.start({
      args: [await testServer.connectionString()]
    });
    await shell.waitForPrompt();

    const compactResult = await shell.executeLine('db.test.compactStructuredEncryptionData()');
    expect(compactResult).to.include('The "compactStructuredEncryptionData" command requires Mongo instance configured with auto encryption.');
  });

  context('6.0+', () => {
    skipIfServerVersion(testServer, '< 6.0'); // Queryable Encryption only available on 6.0+

    it('allows explicit encryption with bypassQueryAnalysis', async function() {
      if (isMacosTooOldForQE()) {
        return this.skip();
      }

      // No --cryptSharedLibPath since bypassQueryAnalysis is also a community edition feature
      const shell = TestShell.start({ args: ['--nodb'] });
      const uri = JSON.stringify(await testServer.connectionString());

      await shell.waitForPrompt();

      await shell.executeLine(`{
        client = Mongo(${uri}, {
          keyVaultNamespace: '${dbname}.keyVault',
          kmsProviders: { local: { key: 'A'.repeat(128) } },
          bypassQueryAnalysis: true
        });

        keyVault = client.getKeyVault();
        clientEncryption = client.getClientEncryption();

        // Create necessary data key
        dataKey = keyVault.createKey('local');

        coll = client.getDB('${dbname}').encryptiontest;
        client.getDB('${dbname}').createCollection('encryptiontest', {
          encryptedFields: {
            fields: [{
              keyId: dataKey,
              path: 'v',
              bsonType: 'string',
              queries: [{ queryType: 'equality' }]
            }]
          }
        });

        // Encrypt and insert data encrypted with specified data key
        const insertPayload1 = clientEncryption.encrypt(dataKey, '123', {
          algorithm: 'Indexed',
          contentionFactor: 4
        });

        const insertPayload2 = clientEncryption.encrypt(dataKey, '456', {
          algorithm: 'Indexed',
          contentionFactor: 4
        });

        const insertRes1 = coll.insertOne({ v: insertPayload1, _id: 'asdf' });
        const insertRes2 = coll.insertOne({ v: insertPayload2, _id: 'ghjk' });
      }`
      );
      expect(await shell.executeLine('({ count: coll.countDocuments() })')).to.include('{ count: 2 }');

      await shell.executeLine(`
      const findPayload = clientEncryption.encrypt(dataKey, '456', { // NB: the data key is irrelevant here
        algorithm: 'Indexed',
        queryType: 'equality',
        contentionFactor: 4
      });`);

      // Make sure the find payload allows searching for the encrypted value
      expect(await shell.executeLine('coll.findOne({ v: findPayload })._id')).to.include('ghjk');
    });

    it('drops fle2 collection with all helper collections when encryptedFields options are in listCollections', async() => {
      const shell = TestShell.start({ args: ['--nodb', `--cryptSharedLibPath=${cryptLibrary}`] });
      const uri = JSON.stringify(await testServer.connectionString());

      await shell.waitForPrompt();

      await shell.executeLine('local = { key: BinData(0, "kh4Gv2N8qopZQMQYMEtww/AkPsIrXNmEMxTrs3tUoTQZbZu4msdRUaR8U5fXD7A7QXYHcEvuu4WctJLoT+NvvV3eeIg3MD+K8H9SR794m/safgRHdIfy6PD+rFpvmFbY") }');

      await shell.executeLine(`keyMongo = Mongo(${uri}, { \
        keyVaultNamespace: '${dbname}.keyVault', \
        kmsProviders: { local } \
      });`);

      await shell.executeLine('keyVault = keyMongo.getKeyVault();');
      await shell.executeLine('keyId = keyVault.createKey("local");');

      await shell.executeLine(`encryptedFieldsMap = { \
        '${dbname}.collfle2': { \
          fields: [{ path: 'phoneNumber', keyId, bsonType: 'string' }] \
        } \
      };`);

      await shell.executeLine(`autoMongo = Mongo(${uri}, { \
        keyVaultNamespace: '${dbname}.keyVault', \
        kmsProviders: { local }, \
        encryptedFieldsMap \
      });`);

      // Drivers will create the auxilliary FLE2 collections only when explicitly creating collections
      // via the createCollection() command.
      await shell.executeLine(`autoMongo.getDB('${dbname}').createCollection('collfle2');`);
      await shell.executeLine(`autoMongo.getDB('${dbname}').collfle2.insertOne({ \
        phoneNumber: '+12874627836445' \
      });`);

      const autoMongoResult = await shell.executeLine(`autoMongo.getDB('${dbname}').collfle2.find()`);
      expect(autoMongoResult).to.include("phoneNumber: '+12874627836445'");

      await shell.executeLine(`plainMongo = Mongo(${uri});`);

      const plainMongoResult = await shell.executeLine(`plainMongo.getDB('${dbname}').collfle2.find()`);
      expect(plainMongoResult).to.include('phoneNumber: Binary(Buffer.from');
      expect(plainMongoResult).to.not.include("phoneNumber: '+12874627836445'");

      let collections = await shell.executeLine(`plainMongo.getDB('${dbname}').getCollectionNames()`);

      expect(collections).to.include('enxcol_.collfle2.ecc');
      expect(collections).to.include('enxcol_.collfle2.esc');
      expect(collections).to.include('enxcol_.collfle2.ecoc');
      expect(collections).to.include('collfle2');

      await shell.executeLine(`plainMongo.getDB('${dbname}').collfle2.drop();`);

      collections = await shell.executeLine(`plainMongo.getDB('${dbname}').getCollectionNames()`);

      expect(collections).to.not.include('enxcol_.collfle2.ecc');
      expect(collections).to.not.include('enxcol_.collfle2.esc');
      expect(collections).to.not.include('enxcol_.collfle2.ecoc');
      expect(collections).to.not.include('collfle2');
    });

    it('allows compactStructuredEncryptionData command when mongo instance configured with auto encryption', async() => {
      const shell = TestShell.start({
        args: ['--nodb', `--cryptSharedLibPath=${cryptLibrary}`]
      });
      const uri = JSON.stringify(await testServer.connectionString());

      await shell.waitForPrompt();

      await shell.executeLine('local = { key: BinData(0, "kh4Gv2N8qopZQMQYMEtww/AkPsIrXNmEMxTrs3tUoTQZbZu4msdRUaR8U5fXD7A7QXYHcEvuu4WctJLoT+NvvV3eeIg3MD+K8H9SR794m/safgRHdIfy6PD+rFpvmFbY") }');

      await shell.executeLine(`keyMongo = Mongo(${uri}, { \
        keyVaultNamespace: '${dbname}.keyVault', \
        kmsProviders: { local } \
      });`);

      await shell.executeLine('keyVault = keyMongo.getKeyVault();');
      await shell.executeLine('keyId = keyVault.createKey("local");');

      await shell.executeLine(`encryptedFieldsMap = { \
        '${dbname}.test': { \
          fields: [{ path: 'phoneNumber', keyId, bsonType: 'string' }] \
        } \
      };`);

      await shell.executeLine(`autoMongo = Mongo(${uri}, { \
        keyVaultNamespace: '${dbname}.keyVault', \
        kmsProviders: { local }, \
        encryptedFieldsMap \
      });`);

      await shell.executeLine(`autoMongo.getDB('${dbname}').createCollection('test', { encryptedFields: { fields: [] } });`);
      await shell.executeLine(`autoMongo.getDB('${dbname}').test.insertOne({ \
        phoneNumber: '+12874627836445' \
      });`);

      const compactResult = await shell.executeLine(`autoMongo.getDB('${dbname}').test.compactStructuredEncryptionData()`);
      expect(compactResult).to.include('ok: 1');
    });

    it('creates an encrypted collection and generates data encryption keys automatically per encrypted fields', async() => {
      const shell = TestShell.start({ args: ['--nodb'] });
      const uri = JSON.stringify(await testServer.connectionString());
      await shell.waitForPrompt();
      await shell.executeLine('local = { key: BinData(0, "kh4Gv2N8qopZQMQYMEtww/AkPsIrXNmEMxTrs3tUoTQZbZu4msdRUaR8U5fXD7A7QXYHcEvuu4WctJLoT+NvvV3eeIg3MD+K8H9SR794m/safgRHdIfy6PD+rFpvmFbY") }');
      await shell.executeLine(`keyMongo = Mongo(${uri}, {
        keyVaultNamespace: '${dbname}.keyVault',
        kmsProviders: { local },
        explicitEncryptionOnly: true
      });`);
      await shell.executeLine(`secretDB = keyMongo.getDB('${dbname}')`);
      await shell.executeLine(`var { collection, encryptedFields } = secretDB.createEncryptedCollection('secretCollection', {
        provider: 'local',
        createCollectionOptions: {
          encryptedFields: {
            fields: [{
              keyId: null,
              path: 'secretField',
              bsonType: 'string'
            }]
          }
        }
      });`);

      await shell.executeLine(`plainMongo = Mongo(${uri});`);
      const collections = await shell.executeLine(`plainMongo.getDB('${dbname}').getCollectionNames()`);
      expect(collections).to.include('enxcol_.secretCollection.ecc');
      expect(collections).to.include('enxcol_.secretCollection.esc');
      expect(collections).to.include('enxcol_.secretCollection.ecoc');
      expect(collections).to.include('secretCollection');

      const dekCount = await shell.executeLine(`plainMongo.getDB('${dbname}').getCollection('keyVault').countDocuments()`);
      // Since there is only one field to be encrypted hence there would only be one DEK in our keyvault collection
      expect(parseInt(dekCount.trim(), 10)).to.equal(1);
    });
  });

  context('6.2+', () => {
    skipIfServerVersion(testServer, '< 6.2'); // Range QE only available on 6.2+

    it('allows explicit range encryption with bypassQueryAnalysis', async function() {
      if (isMacosTooOldForQE()) {
        return this.skip();
      }

      // No --cryptSharedLibPath since bypassQueryAnalysis is also a community edition feature
      const shell = TestShell.start({ args: ['--nodb'] });
      const uri = JSON.stringify(await testServer.connectionString());

      await shell.waitForPrompt();

      await shell.executeLine(`{
        client = Mongo(${uri}, {
          keyVaultNamespace: '${dbname}.keyVault',
          kmsProviders: { local: { key: 'A'.repeat(128) } },
          bypassQueryAnalysis: true
        });

        keyVault = client.getKeyVault();
        clientEncryption = client.getClientEncryption();

        // Create necessary data key
        dataKey = keyVault.createKey('local');

        rangeOptions = {
          sparsity: Long(1),
          min: new Date('1970'),
          max: new Date('2100')
        };
        coll = client.getDB('${dbname}').encryptiontest;
        client.getDB('${dbname}').createCollection('encryptiontest', {
          encryptedFields: {
            fields: [{
              keyId: dataKey,
              path: 'v',
              bsonType: 'date',
              queries: [{
                queryType: 'rangePreview',
                contention: 4,
                ...rangeOptions
              }]
            }]
          }
        });

        // Encrypt and insert data encrypted with specified data key
        for (let year = 1990; year < 2010; year++) {
          const insertPayload = clientEncryption.encrypt(
            dataKey,
            new Date(year + '-02-02T12:45:16.277Z'),
            {
              algorithm: 'RangePreview',
              contentionFactor: 4,
              rangeOptions
            });
          coll.insertOne({ v: insertPayload, year });
        }
      }`
      );
      expect(await shell.executeLine('({ count: coll.countDocuments() })')).to.include('{ count: 20 }');

      await shell.executeLine(`{
      findPayload = clientEncryption.encryptExpression(dataKey, {
        $and: [ { v: {$gt: new Date('1992')} }, { v: {$lt: new Date('1999')} } ]
      }, {
        algorithm: 'RangePreview',
        queryType: 'rangePreview',
        contentionFactor: 4,
        rangeOptions
      });
      }`);

      // Make sure the find payload allows searching for the encrypted values
      const out = await shell.executeLine('\
        coll.find(findPayload) \
          .toArray() \
          .map(d => d.year) \
          .sort() \
          .join(\',\')');
      expect(out).to.include('1992,1993,1994,1995,1996,1997,1998');
    });

    it('allows automatic range encryption', async function() {
      if (isMacosTooOldForQE()) {
        return this.skip();
      }

      const shell = TestShell.start({ args: ['--nodb', `--cryptSharedLibPath=${cryptLibrary}`] });
      const uri = JSON.stringify(await testServer.connectionString());

      await shell.waitForPrompt();

      await shell.executeLine(`{
        client = Mongo(${uri}, {
          keyVaultNamespace: '${dbname}.keyVault',
          kmsProviders: { local: { key: 'A'.repeat(128) } }
        });

        dataKey = client.getKeyVault().createKey('local');

        coll = client.getDB('${dbname}').encryptiontest;
        client.getDB('${dbname}').createCollection('encryptiontest', {
          encryptedFields: {
            fields: [{
              keyId: dataKey,
              path: 'v',
              bsonType: 'date',
              queries: [{
                queryType: 'rangePreview',
                contention: 4,
                sparsity: 1,
                min: new Date('1970'),
                max: new Date('2100')
              }]
            }]
          }
        });

        for (let year = 1990; year < 2010; year++) {
          coll.insertOne({ v: new Date(year + '-02-02T12:45:16.277Z'), year })
        }
      }`
      );
      expect(await shell.executeLine('({ count: coll.countDocuments() })')).to.include('{ count: 20 }');

      // Make sure the find payload allows searching for the encrypted values
      const out = await shell.executeLine('\
        coll.find({ v: {$gt: new Date(\'1992\'), $lt: new Date(\'1999\') } }) \
          .toArray() \
          .map(d => d.year) \
          .sort() \
          .join(\',\')');
      expect(out).to.include('1992,1993,1994,1995,1996,1997,1998');
    });
  });

  context('pre-6.0', () => {
    skipIfServerVersion(testServer, '>= 6.0'); // FLE2 available on 6.0+

    it('provides a good error message when createCollection fails due to low server version', async function() {
      const shell = TestShell.start({
        args: [`--cryptSharedLibPath=${cryptLibrary}`, await testServer.connectionString()]
      });
      await shell.waitForPrompt();
      const result = await shell.executeLine(`db.getSiblingDB('${dbname}').createCollection('test', { encryptedFields: { fields: [] } });`);
      expect(result).to.match(/Your server version is .+, which does not support Queryable Encryption/);
    });

    it('provides a good error message when createCollection fails due to low FCV', async function() {
      const shell = TestShell.start({
        args: [`--cryptSharedLibPath=${cryptLibrary}`, await testServer.connectionString()]
      });
      await shell.waitForPrompt();
      await shell.executeLine(`db = db.getSiblingDB('${dbname}')`);
      await shell.executeLine('db.version = () => \'6.0.0\'');
      const result = await shell.executeLine('db.createCollection(\'test\', { encryptedFields: { fields: [] } });');
      expect(result).to.match(/Your featureCompatibilityVersion is .+, which does not support Queryable Encryption/);
    });
  });

  it('performs KeyVault data key management as expected', async() => {
    const shell = TestShell.start({
      args: [await testServer.connectionString(), `--cryptSharedLibPath=${cryptLibrary}`]
    });
    await shell.waitForPrompt();
    // Wrapper for executeLine that expects single-line output
    const runSingleLine = async(line) => (await shell.executeLine(line)).split('\n')[0].trim();
    await runSingleLine('local = { key: BinData(0, "kh4Gv2N8qopZQMQYMEtww/AkPsIrXNmEMxTrs3tUoTQZbZu4msdRUaR8U5fXD7A7QXYHcEvuu4WctJLoT+NvvV3eeIg3MD+K8H9SR794m/safgRHdIfy6PD+rFpvmFbY") }');
    await runSingleLine(`keyMongo = Mongo(db.getMongo(), { \
      keyVaultNamespace: '${dbname}.keyVault', \
      kmsProviders: { local }, \
      explicitEncryptionOnly: true \
    });`);
    await runSingleLine(`use('${dbname}')`);
    await runSingleLine('keyVault = keyMongo.getKeyVault();');
    await runSingleLine('keyId = keyVault.createKey("local", "", ["testaltname"]);');
    expect(await runSingleLine('db.keyVault.countDocuments({ _id: keyId, keyAltNames: "testaltname" })'))
      .to.equal('1');
    expect(await runSingleLine('keyVault.getKey(keyId)._id.toString() == keyId.toString()'))
      .to.equal('true');
    expect(await runSingleLine('keyVault.getKeys().next()._id.toString() == keyId.toString()'))
      .to.equal('true');
    expect(await runSingleLine('keyVault.addKeyAlternateName(keyId, "otheraltname").keyAltNames.join(",")'))
      .to.equal('testaltname');
    expect(await runSingleLine('keyVault.getKeyByAltName("otheraltname").keyAltNames.join(",")'))
      .to.equal('testaltname,otheraltname');
    expect(await runSingleLine('keyVault.removeKeyAlternateName(keyId, "testaltname").keyAltNames.join(",")'))
      .to.equal('testaltname,otheraltname');
    expect(await runSingleLine('keyVault.getKeyByAltName("otheraltname").keyAltNames.join(",")'))
      .to.equal('otheraltname');
    expect(await runSingleLine('keyVault.deleteKey(keyId).deletedCount'))
      .to.equal('1');
    expect(await runSingleLine('db.keyVault.countDocuments()'))
      .to.equal('0');
  });

  it('allows a migration path for users from cursor getKey[ByAltName] to single document getKey[ByAltName]', async() => {
    const shell = TestShell.start({
      args: [await testServer.connectionString(), `--cryptSharedLibPath=${cryptLibrary}`]
    });
    await shell.waitForPrompt();
    // Wrapper for executeLine that expects single-line output
    const runSingleLine = async(line) => (await shell.executeLine(line)).split('\n')[0].trim();
    await runSingleLine('local = { key: BinData(0, "kh4Gv2N8qopZQMQYMEtww/AkPsIrXNmEMxTrs3tUoTQZbZu4msdRUaR8U5fXD7A7QXYHcEvuu4WctJLoT+NvvV3eeIg3MD+K8H9SR794m/safgRHdIfy6PD+rFpvmFbY") }');
    await runSingleLine(`keyMongo = Mongo(db.getMongo(), { \
      keyVaultNamespace: '${dbname}.keyVault', \
      kmsProviders: { local }, \
      explicitEncryptionOnly: true \
    });`);
    await runSingleLine(`use('${dbname}')`);
    await runSingleLine('keyVault = keyMongo.getKeyVault();');
    await runSingleLine('keyId = keyVault.createKey("local", "", ["testaltname"]);');

    // Can access values with cursor methods, but get a deprecation warning
    {
      const output = await shell.executeLine('keyVault.getKey(keyId).next().masterKey.provider');
      expect(output).to.include('DeprecationWarning: KeyVault.getKey returns a single document and will stop providing cursor methods in future versions of mongosh');
      expect(output).to.match(/\blocal\b/);
    }
    {
      const output = await shell.executeLine('keyVault.getKeyByAltName("testaltname").next().masterKey.provider');
      expect(output).to.include('DeprecationWarning: KeyVault.getKeyByAltName returns a single document and will stop providing cursor methods in future versions of mongosh');
      expect(output).to.match(/\blocal\b/);
    }

    // Can access values on document directly
    {
      const output = await shell.executeLine('keyVault.getKey(keyId).masterKey.provider');
      expect(output).to.not.include('DeprecationWarning');
      expect(output).to.match(/\blocal\b/);
    }
    {
      const output = await shell.executeLine('keyVault.getKeyByAltName("testaltname").masterKey.provider');
      expect(output).to.not.include('DeprecationWarning');
      expect(output).to.match(/\blocal\b/);
    }

    // Works when no doc is returned
    {
      const output = await shell.executeLine('keyVault.getKey("nonexistent")');
      expect(output).to.include('no result -- will return `null` in future mongosh versions');
    }
    {
      const output = await shell.executeLine('keyVault.getKeyByAltName("nonexistent")');
      expect(output).to.include('no result -- will return `null` in future mongosh versions');
    }

    // Hack to reset deprecation warning cache
    await shell.executeLine('db.getMongo()._instanceState.warningsShown.clear()');

    // Works when no doc is returned with cursor methods
    {
      const output = await shell.executeLine('keyVault.getKey("nonexistent").next()');
      expect(output).to.include('DeprecationWarning');
      expect(output).to.match(/\bnull\b/);
    }
    {
      const output = await shell.executeLine('keyVault.getKeyByAltName("nonexistent").next()');
      expect(output).to.include('DeprecationWarning');
      expect(output).to.match(/\bnull\b/);
    }
  });
});

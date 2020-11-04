/* eslint no-console: 0, no-empty-function: 0, camelcase: 0 */

import redactInfo from 'mongodb-redact';
import Analytics from 'analytics-node';
import { retractPassword } from '@mongosh/history';
import { bson } from '@mongosh/service-provider-core';
import pino from 'pino';
import path from 'path';

interface ApiEventArguments {
  pipeline?: any[];
  query?: object;
  options?: object;
  filter?: object;
}

interface ApiEvent {
  method?: string;
  class?: string;
  db?: string;
  coll?: string;
  arguments?: ApiEventArguments;
}

interface UseEvent {
  db: string;
}

interface AsyncRewriterEvent {
  original: string;
  rewritten: string;
}

interface ShowEvent {
  method: string;
}

interface ConnectEvent {
  is_atlas: boolean;
  is_localhost: boolean;
  server_version: string;
  server_os?: string;
  server_arch?: string;
  is_enterprise: boolean;
  auth_type?: string;
  is_data_lake: boolean;
  dl_version?: string;
  is_genuine: boolean;
  non_genuine_server_name: string;
  node_version: string;
  uri: string;
}

// set up a noop, in case we are not able to connect to segment.
class NoopAnalytics {
  identify(_info: any): void {} // eslint-disable-line @typescript-eslint/no-unused-vars
  track(_info: any): void {} // eslint-disable-line @typescript-eslint/no-unused-vars
}

export default function setupLoggerAndTelemetry(bus: any, logDir: string): void {
  const session_id = new bson.ObjectId().toString();
  const logDest = path.join(logDir, `${session_id}_log`);
  const log = pino({ name: 'monogsh' }, pino.destination(logDest));
  console.log(`Current sessionID:  ${session_id}`);
  let userId: any;
  let telemetry: boolean;

  let analytics = new NoopAnalytics();
  try {
    // this file gets written as a part of a release
    analytics = new Analytics(require('./analytics-config.js').SEGMENT_API_KEY);
  } catch (e) {
    log.error(e);
  }

  bus.on('mongosh:connect', function(args: ConnectEvent) {
    const connectionUri = retractPassword(args.uri);
    const { uri: _uri, ...argsWithoutUri } = args; // eslint-disable-line @typescript-eslint/no-unused-vars
    const params = { session_id, userId, connectionUri, ...argsWithoutUri };
    log.info('mongosh:connect', params);

    if (telemetry) {
      analytics.track({
        userId,
        event: 'New Connection',
        properties: { session_id, ...argsWithoutUri }
      });
    }
  });

  bus.on('mongosh:new-user', function(id: any, enableTelemetry: boolean) {
    userId = id;
    telemetry = enableTelemetry;
    if (telemetry) analytics.identify({ userId });
  });

  bus.on('mongosh:update-user', function(id: any, enableTelemetry: boolean) {
    userId = id;
    telemetry = enableTelemetry;
    if (telemetry) analytics.identify({ userId });
    log.info('mongosh:update-user', { enableTelemetry });
  });

  bus.on('mongosh:error', function(error: any) {
    log.error(error);

    if (telemetry && error.name.includes('Mongosh')) {
      analytics.track({
        userId,
        event: 'Error',
        properties: { error }
      });
    }
  });

  bus.on('mongosh:help', function() {
    log.info('mongosh:help');

    if (telemetry) {
      analytics.track({
        userId,
        event: 'Help'
      });
    }
  });

  bus.on('mongosh:rewritten-async-input', function(args: AsyncRewriterEvent) {
    log.info('mongosh:rewritten-async-input', args);
  });

  bus.on('mongosh:use', function(args: UseEvent) {
    log.info('mongosh:use', args);

    if (telemetry) {
      analytics.track({
        userId,
        event: 'Use'
      });
    }
  });

  bus.on('mongosh:show', function(args: ShowEvent) {
    log.info('mongosh:show', args);

    if (telemetry) {
      analytics.track({
        userId,
        event: 'Show',
        properties: { method: args.method }
      });
    }
  });

  bus.on('mongosh:setCtx', function(args: ApiEvent) {
    log.info('mongosh:setCtx', args);
  });

  bus.on('mongosh:api-call', function(args: ApiEvent) {
    log.info('mongosh:api-call', redactInfo(args));
  });
}

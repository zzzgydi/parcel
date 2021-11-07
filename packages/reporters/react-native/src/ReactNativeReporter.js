// @flow strict-local
import type {PluginOptions} from '@parcel/types';
import type {IncomingMessage, ServerResponse} from 'http';

import nullthrows from 'nullthrows';
import path from 'path';
// $FlowFixMe
import {Server as WebSocketServer} from 'ws';
import {Reporter} from '@parcel/plugin';
import {createHTTPServer} from '@parcel/utils';
// $FlowFixMe[untyped-import]
import {createProxyMiddleware} from 'http-proxy-middleware';
import SourceMap from '@parcel/source-map';
import formatCodeFrame from '@parcel/codeframe';

// $FlowFixMe[untyped-import]
import {createDevServerMiddleware} from '@react-native-community/cli-server-api';

// GET "/status" -> "packager-status: running"
// GET "/inspector" -> ws
// GET "/message" -> ws
// GET "/hot" -> ws
// POST "/logs" with
// [
//   {
//     "count": 0,
//     "level": "info",
//     "body": [
//       "Running \"main\" with {...}"
//     ],
//     "includesStack": false,
//     "groupDepth": 0
//   }
// ]

let server;
let wss;

export default (new Reporter({
  async report({event, options, logger}) {
    switch (event.type) {
      case 'watchStart': {
        let serveOptions = options.serveOptions;
        if (serveOptions === false) {
          return;
        }

        const {middleware, attachToServer} = createDevServerMiddleware({
          host: '127.0.0.1',
          port: 8081,
          watchFolders: [],
        });

        let devServerProxyMiddleware = createProxyMiddleware({
          target: `http://${serveOptions.host ?? 'localhost'}:${
            serveOptions.port
          }`,
          changeOrigin: true,
          logLevel: 'warn',
          pathRewrite: {'^/index.bundle': '/index.js'},
        });
        let devServer = await createHTTPServer({
          cacheDir: options.cacheDir,
          https: serveOptions.https,
          inputFS: options.inputFS,
          // $FlowFixMe
          listener: async (req: IncomingMessage, res: ServerResponse) => {
            logger.verbose({
              message: `Request: ${req.headers.host}${req.url}`,
            });

            if (req.url === '/symbolicate') {
              try {
                const buffers = [];
                for await (const chunk of req) {
                  buffers.push(Buffer.from(chunk));
                }
                const data = JSON.parse(Buffer.concat(buffers).toString());

                res.statusCode = 200;
                res.end(JSON.stringify(await symbolicate(options, data)));
              } catch (e) {
                res.statusCode = 500;
                res.end();
              }
            } else {
              middleware(req, res, () => {
                if (req.url.startsWith('/index.bundle')) {
                  req.url = '/entry.js';
                }
                devServerProxyMiddleware(req, res);
              });
            }
          },
          outputFS: options.outputFS,
        });

        /* const {debuggerProxy, eventsSocket, messageSocket} =  */ attachToServer(
          devServer.server,
        );
        // if (cmd === 'r') {
        //   messageSocket.broadcast('reload', null);

        //   _cliTools().logger.info('Reloading app...');
        // } else if (cmd === 'd') {
        //   messageSocket.broadcast('devMenu', null);
        //   _cliTools().logger.info('Opening developer menu...');
        // }

        await new Promise(res => devServer.server.listen(8081, res));

        logger.info({
          message: 'React Native server running at port 8081',
        });

        wss = new WebSocketServer({server: devServer.server, path: '/hot'});
        wss.on('connection', function connection(ws) {
          ws.on('message', function incoming(message) {
            let data:
              | {|
                  +type: 'register-entrypoints',
                  +entryPoints: Array<string>,
                |}
              | {|
                  +type: 'log',
                  +level:
                    | 'trace'
                    | 'info'
                    | 'warn'
                    | 'log'
                    | 'group'
                    | 'groupCollapsed'
                    | 'groupEnd'
                    | 'debug',
                  +data: Array<mixed>,
                  +mode: 'BRIDGE' | 'NOBRIDGE',
                |}
              | {|
                  +type: 'log-opt-in',
                |} = JSON.parse(message);
            handleHotMessage(logger, data);
          });
        });

        break;
      }

      case 'watchEnd':
        if (server != null) {
          await server.stop();
        }
        break;
    }
  },
}): Reporter);

const INTERNAL_CALLSITES_REGEX = new RegExp(
  [
    '/Libraries/Renderer/implementations/.+\\.js$',
    '/Libraries/BatchedBridge/MessageQueue\\.js$',
    '/Libraries/YellowBox/.+\\.js$',
    '/Libraries/LogBox/.+\\.js$',
    '/Libraries/Core/Timers/.+\\.js$',
    '/node_modules/react-devtools-core/.+\\.js$',
    '/node_modules/react-refresh/.+\\.js$',
    '/node_modules/scheduler/.+\\.js$',
  ].join('|'),
);

async function symbolicate(
  options: PluginOptions,
  data: {|
    stack: Array<{|
      file: string,
      lineNumber: ?number,
      column: ?number,
      methodName: string,
    |}>,
  |},
) {
  let mapData = JSON.parse(
    // TODO
    await options.outputFS.readFile('./dist/index.js.map', 'utf8'),
  );

  let map = new SourceMap(options.projectRoot);
  map.addVLQMap(mapData);
  let translatedStack = data.stack.map(({column, lineNumber, methodName}) => {
    let result =
      lineNumber != null && column != null
        ? map.findClosestMapping(lineNumber, column)
        : null;
    return {
      methodName,
      column: result ? nullthrows(result.original).column : null,
      lineNumber: result ? nullthrows(result.original).line : null,
      arguments: [],
      file:
        result?.source != null
          ? path.resolve(options.projectRoot, result.source)
          : '',
      collapse:
        result?.source != null && INTERNAL_CALLSITES_REGEX.test(result.source),
    };
  });
  let codeFrame = translatedStack.find(f => !f.collapse);

  // TODO useColor isn't donig anything
  let formattedCodeFrame =
    codeFrame != null &&
    codeFrame.lineNumber != null &&
    codeFrame.column != null
      ? {
          content: formatCodeFrame(
            map.getSourceContent(codeFrame.file) ??
              (await options.inputFS.readFile(codeFrame.file, 'utf8')),
            [
              {
                start: {
                  // $FlowFixMe
                  line: codeFrame.lineNumber,
                  // $FlowFixMe
                  column: codeFrame.column,
                },
                end: {
                  // $FlowFixMe
                  line: codeFrame.lineNumber,
                  // $FlowFixMe
                  column: codeFrame.column,
                },
              },
            ],
            {
              useColor: true,
              syntaxHighlighting: true,
              language: path.extname(codeFrame.file).substr(1),
            },
          ),
          fileName: codeFrame.file,
          location: {
            column: codeFrame.column,
            row: codeFrame.lineNumber,
          },
        }
      : null;

  return {
    codeFrame: formattedCodeFrame,
    stack: translatedStack,
  };
}

function handleHotMessage(logger, data) {
  if (data.type === 'log') {
    let diagnostic = {
      message: 'Client: ' + data.data.join(','),
    };
    switch (data.level) {
      case 'debug':
      case 'trace':
        logger.verbose(diagnostic);
        break;
      case 'info':
        logger.info(diagnostic);
        break;
      case 'warn':
        logger.warn(diagnostic);
        break;
      case 'log':
      case 'group':
      case 'groupCollapsed':
      case 'groupEnd':
        logger.log(diagnostic);
        break;
    }
  }
}
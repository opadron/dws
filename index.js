
let fs = require('fs');
let http = require('http');
let path = require('path');
let proc = require('process');
let stream = require('stream');

let { ArgumentParser } = require('argparse');
let winston = require('winston');

let parser = new ArgumentParser({
  version: '0.0.1',
  addHelp: true,
  description: 'dead-simple skeleton web server'
});

parser.addArgument(['-q', '--queue-dir'],
  { help: 'Path in which to enqueue pending requests',
    defaultValue: 'queue' });

parser.addArgument(['-c', '--cache-dir'],
  { help: 'Path from which to read response data',
    defaultValue: 'cache' });

parser.addArgument(['-b', '--bind'],
  { help: 'Hostname/IP to bind onto',
    defaultValue: 'localhost' });

parser.addArgument(['-p', '--port'],
  { help: 'Port number to listen on',
    type: 'int',
    defaultValue: 8080 });

let args = parser.parseArgs();

winston.configure({
  level: 'verbose',

  format: winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(
      (info) => [info.timestamp, ' ', info.level, ': ', info.message].join(''))
  ),

  transports: [new winston.transports.Console()]
});

let { info, warn, error } = winston;

try { fs.mkdirSync(args.queue_dir); }
catch (err) { if (err.code !== 'EEXIST') throw err; }

try { fs.mkdirSync(args.cache_dir); }
catch (err) { if (err.code !== 'EEXIST') throw err; }

const encodeRef = (ref) => {
  let result = Buffer.from(ref).toString('base64');

  let n = result.length;
  if (result.endsWith('==')) { result = result.substr(0, n - 2); }
  if (result.endsWith('='))  { result = result.substr(0, n - 1); }

  return result;
};

const decodeRef = (ref) => {
  let n = ref.length % 4;

  if (n == 2) { ref = [ref, '=='].join(''); }
  if (n == 1) { ref = [ref, '='].join(''); }

  let result = Buffer.from(ref, 'base64').toString('ascii');

  return result;
};

const makeDeferredPromise = () => {
  let p;
  return new Promise((resolve, reject) => {
    return p = new Promise((rs, rj) => { resolve([rs, rj]); });
  }).then(([rs, rj]) => [p, rs, rj]);
};

let promiseTable = {};
const readResultFromFile = (ref, res) => new Promise((resolve, reject) => {
  fs.open(path.join(args.cache_dir, ref), 'r', (err, fd) => {
    if (err) {
      reject(err);
      return;
    }

    let meta = {
      code: 200,
      cType: 'text/plain'
    };

    fd = fs.createReadStream(null, { fd });

    let jsonSize;
    let jsonSizeParsed = false;
    let jsonSizeBuffer = [];

    let jsonBuffer = [];
    let json = null;

    fd.on('close', resolve);

    fd.on('data', (chunk) => {
      chunk = chunk.toString('utf-8');
      if (!jsonSizeParsed) {
        let i = chunk.indexOf('\n');
        if (i < 0) { jsonSizeBuffer.push(chunk); }
        else {
          jsonSizeBuffer.push(chunk.substr(0, i));

          jsonSize = Number.parseInt(jsonSizeBuffer.join(''));
          chunk = chunk.substr(i+1);
          jsonSizeParsed = true;
        }
      }

      if (!jsonSizeParsed) { return; }

      let n = chunk.length;
      if (n === 0) { return; }

      if (!json) {
        if (n > jsonSize) { n = jsonSize; }
        jsonBuffer.push(chunk.substr(0, n));
        jsonSize -= n;

        chunk = chunk.substr(n);

        if (jsonSize === 0) {
          let jsonText = jsonBuffer.join('');
          json = {};
          if (jsonText.length > 0) {
            json = JSON.parse(jsonBuffer.join(''));
            meta = { ...meta, ...json };
          }
          res.writeHead(meta.code, { 'Content-Type': meta.cType });
        }
      }

      if (!json) { return; }
      if (chunk.length === 0) { return; }

      res.write(chunk);
    });
  });
});

const getResult = async (ref, res) => {
  for (;;) {
    try {
      await readResultFromFile(ref, res);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        error(err);
      }
    }

    if (!promiseTable[ref]) {
      let fd = fs.openSync(path.join(args.queue_dir, ref), 'w');
      fs.closeSync(fd);

      promiseTable[ref] = await makeDeferredPromise();
    }

    await promiseTable[ref][0];
  }
};

const handlePost = (req, res, ref) => {
  let nRef = decodeRef(ref);
  info(`POST ${ req.connection.remoteAddress } ${ ref } (${ nRef })`);
  let entry = promiseTable[ref];
  delete promiseTable[ref];

  if (entry) { entry[1](); } /* resolve */

  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end();
};

const handleGet = async (req, res, ref) => {
  let eRef = encodeRef(ref);
  info(`GET  ${ req.connection.remoteAddress } ${ ref } (${ eRef })`);
  await getResult(encodeRef(ref), res);
  res.end();
};

(
  http.createServer(async (req, res) => {
    let path = req.url.substr(1);
    if (path.endsWith('/')) { path = path.substr(0, path.length - 1); }

    if (req.method.toLowerCase() === 'post') {
      handlePost(req, res, path);
    }

    if (req.method.toLowerCase() === 'get') {
      handleGet(req, res, path);
    }
  })

  .listen(args.port, args.bind, () => {
    info(`Listening on port ${ args.port }`);
  })
);

/** Actual workerd smoke: the deployable entry remains email-only. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'omr-email-runtime-'));
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
let nativeBytes = 0;
let redirected = false;
const receiver = createHttpServer(async (request, response) => {
  if (request.url === '/redirected') redirected = true;
  for await (const chunk of request) nativeBytes += chunk.length;
  response.writeHead(
    request.url === '/redirect' ? 307 : 204,
    request.url === '/redirect'
      ? { location: '/redirected' }
      : { 'x-omr-email-result': 'accepted' },
  );
  response.end();
});
await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const receiverPort = receiver.address().port;
const relay = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
await writeFile(
  join(directory, 'entry.mjs'),
  `import relay from ${JSON.stringify(relay)};
export default {async fetch(){
 const bytes=5*1024*1024,chunkSize=32768,secret='runtime-test-secret-not-for-production';
 let produced=0,consumed=0,maxOutstanding=0,verified=false,rejection=null;
 const message={to:'reader@onmyradar.io',rawSize:bytes,setReject(value){rejection=value;},raw:new ReadableStream({pull(controller){
   if(produced===bytes){controller.close();return;}
   const length=Math.min(chunkSize,bytes-produced);produced+=length;
   maxOutstanding=Math.max(maxOutstanding,produced-consumed);controller.enqueue(new Uint8Array(length).fill(7));
 }})};
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
   const h=options.headers;
   const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
   const signature=Uint8Array.from(h['x-omr-signature'].match(/../g),byte=>parseInt(byte,16));
   verified=await crypto.subtle.verify('HMAC',key,signature,new TextEncoder().encode([h['x-omr-timestamp'],h['x-omr-nonce'],h['x-omr-recipient'],h['x-omr-raw-size']].join('\\n')));
   if(url!=='https://onmyradar.io/hooks/email-capture/raw'||options.redirect!=='manual')throw new Error('Unsafe endpoint');
   const metered=options.body.pipeThrough(new TransformStream({transform(chunk,c){if(chunk[0]!==7||chunk[chunk.length-1]!==7)throw new Error('Bytes changed');consumed+=chunk.byteLength;c.enqueue(chunk);}}));
   return original('http://127.0.0.1:${receiverPort}/capture',{...options,body:metered});
 };
 let redirectRefused=false;
 try{
 await relay.email(message,{API_ORIGIN:'https://onmyradar.io',EMAIL_INGEST_SECRET:secret});
 globalThis.fetch=(_url,options)=>original('http://127.0.0.1:${receiverPort}/redirect',options);
 try{await relay.email({...message,rawSize:1,raw:new ReadableStream({start(c){c.enqueue(new Uint8Array([7]));c.close();}})},{API_ORIGIN:'https://onmyradar.io',EMAIL_INGEST_SECRET:secret});}catch(e){redirectRefused=e.message.includes('(307)');}
 }finally{globalThis.fetch=original;}
 return Response.json({verified,bytes:consumed,bounded:maxOutstanding<=4*chunkSize,redirectRefused,rejection});
}};`,
);
await writeFile(
  join(directory, 'wrangler.jsonc'),
  JSON.stringify({
    name: 'onmyradar-email-runtime-test',
    main: 'entry.mjs',
    compatibility_date: '2026-09-19',
  }),
);
const port = await freePort(),
  inspector = await freePort();
const cli = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const child = spawn(
  process.execPath,
  [
    cli,
    'dev',
    '--config',
    join(directory, 'wrangler.jsonc'),
    '--local',
    '--port',
    String(port),
    '--inspector-port',
    String(inspector),
  ],
  { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let logs = '';
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    logs = (logs + chunk).slice(-16000);
  });
let exited = false;
child.once('exit', () => {
  exited = true;
});
try {
  let result;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        result = await response.json();
        break;
      }
    } catch {
      // The local runtime is still starting; retry until the bounded deadline.
    }
    await delay(150);
  }
  if (redirected || nativeBytes !== 5 * 1024 * 1024 + 1)
    throw new Error('Native workerd fetch regression');
  if (
    !result?.verified ||
    !result.redirectRefused ||
    result.bytes !== 5 * 1024 * 1024 ||
    !result.bounded ||
    result.rejection
  )
    throw new Error(`workerd relay regression failed: ${JSON.stringify(result)}\n${logs}`);
  console.log(
    'workerd relay: 5 MiB streamed with bounded buffering, verified HMAC and redirects disabled',
  );
} finally {
  receiver.close();
  child.kill('SIGTERM');
  for (let i = 0; i < 30 && !exited; i++) await delay(100);
  if (!exited) child.kill('SIGKILL');
  await rm(directory, { recursive: true, force: true });
}

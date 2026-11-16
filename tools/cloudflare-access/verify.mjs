#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  await readFile(join(__dirname, 'hosts.json'), 'utf8'),
);

let failed = 0;

async function resolvePublicly(host) {
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const addresses = await resolver.resolve4(host);
  if (!addresses[0]) throw new Error(`no A answer for ${host}`);
  return addresses[0];
}

function requestViaAddress(host, address) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: host,
        port: 443,
        path: '/',
        method: 'GET',
        servername: host,
        headers: { host },
        lookup: (_name, options, callback) =>
          options?.all
            ? callback(null, [{ address, family: 4 }])
            : callback(null, address, 4),
      },
      (response) => {
        response.resume();
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            location: response.headers.location || '',
          }),
        );
      },
    );
    request.setTimeout(15_000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

async function probe(host) {
  try {
    const response = await fetch(`https://${host}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    return {
      status: response.status,
      location: response.headers.get('location') || '',
    };
  } catch {
    const address = await resolvePublicly(host);
    return requestViaAddress(host, address);
  }
}

for (const host of config.hosts) {
  try {
    const response = await probe(host);
    const location = response.location;
    const protectedByAccess =
      response.status >= 300 &&
      response.status < 400 &&
      location.includes(`${config.teamDomain}/`);
    if (!protectedByAccess) failed += 1;
    console.log(
      `${protectedByAccess ? 'OK' : 'FAIL'} ${host} ${response.status} ${location.split('?')[0]}`,
    );
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${host} ${error.message}`);
  }
}

process.exitCode = failed ? 1 : 0;

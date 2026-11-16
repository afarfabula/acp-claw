#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath =
  process.env.OVERLEAF_SYNC_CONFIG || join(__dirname, 'projects.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const stateDir = config.stateDir;
const stateFile = join(stateDir, 'state.json');
const tempDir = join(stateDir, 'tmp');
const conflictDirName = '.overleaf-conflict';

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(tempDir, { recursive: true, mode: 0o700 });

const buildOutputExtensions = [
  '.aux',
  '.bbl',
  '.blg',
  '.dvi',
  '.fdb_latexmk',
  '.fls',
  '.glo',
  '.glg',
  '.gls',
  '.log',
  '.out',
  '.pdf',
  '.pdfsync',
  '.synctex.gz',
  '.toc',
  '.xdv',
];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
  if (!existsSync(stateFile)) return { projects: {} };
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function saveState(state) {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, stateFile);
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function isSyncable(relativePath) {
  const parts = relativePath.split('/');
  if (parts.includes('.git') || parts.includes(conflictDirName)) return false;
  const name = parts.at(-1);
  if ((config.exclude ?? []).includes(name)) return false;
  if (name === '.gitignore') return false;
  if (name === '.latexmkrc') return true;
  if (name.startsWith('.')) return false;
  return !buildOutputExtensions.some(extension => name.endsWith(extension));
}

function collectFiles(root, current = root, result = new Map()) {
  if (!existsSync(root)) return result;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === conflictDirName) continue;
    const absolutePath = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectFiles(root, absolutePath, result);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    if (isSyncable(relativePath)) {
      result.set(relativePath, readFileSync(absolutePath));
    }
  }
  return result;
}

function hashMap(files) {
  return Object.fromEntries(
    [...files.entries()].map(([name, buffer]) => [name, hashBuffer(buffer)]),
  );
}

function writeAtomic(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, buffer);
  renameSync(temp, path);
}

function applySnapshotToDirectory(root, files) {
  const current = collectFiles(root);
  for (const relativePath of current.keys()) {
    if (!files.has(relativePath)) {
      rmSync(join(root, relativePath), { force: true });
    }
  }
  for (const [relativePath, buffer] of files) {
    const fullPath = join(root, relativePath);
    const currentBuffer = existsSync(fullPath)
      ? readFileSync(fullPath)
      : null;
    if (!currentBuffer || !currentBuffer.equals(buffer)) {
      writeAtomic(fullPath, buffer);
    }
  }
}

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function storeCookies(cookies, headers) {
  for (const raw of headers.getSetCookie?.() ?? []) {
    const first = raw.split(';', 1)[0];
    const index = first.indexOf('=');
    if (index > 0) {
      cookies.set(first.slice(0, index), first.slice(index + 1));
    }
  }
}

function match(html, regex) {
  return html.match(regex)?.[1] ?? null;
}

class OverleafClient {
  constructor() {
    this.baseUrl = config.overleafBaseUrl.replace(/\/$/, '');
    this.cookies = new Map();
    this.csrf = null;
  }

  async login() {
    this.cookies.clear();
    const loginResponse = await fetch(`${this.baseUrl}/login`, {
      redirect: 'manual',
    });
    storeCookies(this.cookies, loginResponse.headers);
    const html = await loginResponse.text();
    const csrf = match(
      html,
      /name="_csrf"\s+type="hidden"\s+value="([^"]+)"/,
    );
    if (!csrf) fail('could not find login CSRF token');
    const credentials = Object.fromEntries(
      readFileSync(config.credentialsFile, 'utf8')
        .split('\n')
        .filter(line => line.includes('='))
        .map(line => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    const response = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: cookieHeader(this.cookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _csrf: csrf,
        email: credentials.email,
        password: credentials.password,
      }),
    });
    storeCookies(this.cookies, response.headers);
    if (response.status !== 302 || !this.cookies.has('overleaf.sid')) {
      fail(`Overleaf login failed with HTTP ${response.status}`);
    }
    this.csrf = null;
  }

  async request(path, options = {}, retry = true) {
    if (!this.cookies.has('overleaf.sid')) await this.login();
    const headers = new Headers(options.headers ?? {});
    headers.set('cookie', cookieHeader(this.cookies));
    const response = await fetch(
      path.startsWith('http') ? path : `${this.baseUrl}${path}`,
      { ...options, headers, redirect: 'manual' },
    );
    storeCookies(this.cookies, response.headers);
    if (
      retry &&
      [401, 403].includes(response.status) &&
      response.headers.get('location')?.includes('/login')
    ) {
      await this.login();
      return this.request(path, options, false);
    }
    return response;
  }

  async ensureCsrf(projectId) {
    if (this.csrf) return this.csrf;
    const response = await this.request(`/project/${projectId}`);
    if (!response.ok) fail(`project page returned HTTP ${response.status}`);
    const html = await response.text();
    this.csrf = match(
      html,
      /<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/,
    );
    if (!this.csrf) fail('could not find project CSRF token');
    return this.csrf;
  }

  async projectView(projectId) {
    const page = await this.request(`/project/${projectId}`);
    if (!page.ok) fail(`project page returned HTTP ${page.status}`);
    const html = await page.text();
    const userId = match(
      html,
      /<meta\s+name="ol-user_id"\s+content="([^"]+)"/,
    );
    if (!userId) fail('could not determine Overleaf user id');
    const password = readFileSync(config.webApiPasswordFile, 'utf8').trim();
    const auth = Buffer.from(
      `${config.webApiUser}:${password}`,
      'utf8',
    ).toString('base64');
    const response = await fetch(
      `${config.webApiBaseUrl.replace(/\/$/, '')}/project/${projectId}/join`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      },
    );
    if (!response.ok) {
      fail(`private project API returned HTTP ${response.status}`);
    }
    return response.json();
  }

  async exportProject(projectId) {
    const directory = mkdtempSync(join(tempDir, `remote-${projectId}-`));
    const zip = join(directory, 'project.zip');
    const tree = join(directory, 'tree');
    const response = await this.request(
      `/Project/${projectId}/download/zip`,
    );
    if (!response.ok) {
      fail(`project export returned HTTP ${response.status}`);
    }
    writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    mkdirSync(tree);
    execFileSync('unzip', ['-qq', '-o', zip, '-d', tree]);
    const files = collectFiles(tree);
    rmSync(directory, { recursive: true, force: true });
    return files;
  }

  async deleteRootEntities(projectId, view) {
    const root = view.project.rootFolder?.[0];
    if (!root) fail('project has no root folder');
    const csrf = await this.ensureCsrf(projectId);
    for (const [property, type] of [
      ['docs', 'doc'],
      ['fileRefs', 'file'],
      ['folders', 'folder'],
    ]) {
      for (const entity of root[property] ?? []) {
        const response = await this.request(
          `/project/${projectId}/${type}/${entity._id}`,
          {
            method: 'DELETE',
            headers: { 'X-CSRF-TOKEN': csrf },
          },
        );
        if (!response.ok) {
          fail(`delete ${type} ${entity._id} returned HTTP ${response.status}`);
        }
      }
    }
  }

  async uploadFile(projectId, rootFolderId, relativePath, buffer) {
    const csrf = await this.ensureCsrf(projectId);
    const form = new FormData();
    form.append('name', basename(relativePath));
    form.append('relativePath', relativePath);
    form.append(
      'qqfile',
      new Blob([buffer], { type: 'application/octet-stream' }),
      basename(relativePath),
    );
    const response = await this.request(
      `/Project/${projectId}/upload?folder_id=${rootFolderId}`,
      {
        method: 'POST',
        headers: { 'X-CSRF-TOKEN': csrf },
        body: form,
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      fail(
        `upload ${relativePath} failed: HTTP ${response.status} ${JSON.stringify(result)}`,
      );
    }
    return result.entity_id;
  }

  async replaceProject(project, files) {
    const projectId = project.projectId;
    await this.ensureCsrf(projectId);
    const view = await this.projectView(projectId);
    const rootFolderId = view.project.rootFolder?.[0]?._id;
    if (!rootFolderId) fail('project root folder id is missing');
    if (!files.has(project.mainFile)) {
      fail(`required main file ${project.mainFile} is missing`);
    }
    await this.deleteRootEntities(projectId, view);
    const uploadedIds = new Map();
    for (const [relativePath, buffer] of [...files.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const entityId = await this.uploadFile(
        projectId,
        rootFolderId,
        relativePath,
        buffer,
      );
      uploadedIds.set(relativePath, entityId);
    }
    const csrf = await this.ensureCsrf(projectId);
    const response = await this.request(`/project/${projectId}/settings`, {
      method: 'POST',
      headers: {
        'X-CSRF-TOKEN': csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        compiler: project.compiler || 'xelatex',
        rootDocId: uploadedIds.get(project.mainFile),
      }),
    });
    if (!response.ok) {
      fail(`project settings returned HTTP ${response.status}`);
    }
  }
}

function projectEntries() {
  return Object.entries(config.projects).map(([projectId, project]) => ({
    projectId,
    ...project,
  }));
}

async function syncOnce(project, state, client, bootstrap = false) {
  const local = collectFiles(project.workingTree);
  if (!client) {
    client = new OverleafClient();
    await client.login();
  }
  const remote = await client.exportProject(project.projectId);
  const previous = bootstrap ? {} : state.projects[project.projectId]?.last ?? {};
  const baselineAvailable = Object.keys(previous).length > 0;

  if (!baselineAvailable) {
    // First sync: preserve the newer Overleaf version for common files,
    // keep local-only files, and remove remote-only files.
    const final = new Map();
    for (const [path, remoteBuffer] of remote) {
      final.set(path, remoteBuffer);
      writeAtomic(join(project.workingTree, path), remoteBuffer);
    }
    for (const [path, localBuffer] of local) {
      if (!remote.has(path)) final.set(path, localBuffer);
    }
    await client.replaceProject(project, final);
    state.projects[project.projectId] = {
      last: hashMap(final),
      syncedAt: new Date().toISOString(),
    };
    saveState(state);
    log(`bootstrapped ${project.name}: ${final.size} files`);
    return;
  }

  const final = new Map(local);
  let remoteChangedLocal = false;
  let hasConflict = false;
  const paths = new Set([
    ...Object.keys(previous),
    ...local.keys(),
    ...remote.keys(),
  ]);
  const conflictRoot = join(project.workingTree, conflictDirName);
  const stamp = new Date().toISOString().replaceAll(':', '-');

  for (const path of paths) {
    const localBuffer = local.get(path);
    const remoteBuffer = remote.get(path);
    const localHash = localBuffer ? hashBuffer(localBuffer) : null;
    const remoteHash = remoteBuffer ? hashBuffer(remoteBuffer) : null;
    const previousHash = previous[path] ?? null;
    const localChanged = localHash !== previousHash;
    const overleafChanged = remoteHash !== previousHash;
    if (!overleafChanged || localHash === remoteHash) continue;

    if (!localChanged) {
      if (remoteBuffer) {
        final.set(path, remoteBuffer);
        writeAtomic(join(project.workingTree, path), remoteBuffer);
      } else {
        final.delete(path);
        rmSync(join(project.workingTree, path), { force: true });
      }
      remoteChangedLocal = true;
      log(`Overleaf -> local: ${path}`);
      continue;
    }

    // Both sides changed this path. Keep local as the working version and
    // preserve Overleaf's version in a Git-visible conflict file.
    hasConflict = true;
    if (remoteBuffer) {
      writeAtomic(join(conflictRoot, stamp, path), remoteBuffer);
    }
    log(`conflict: ${path} (local kept, Overleaf copy saved)`);
  }

  const remoteDiffers = [...new Set([...remote.keys(), ...final.keys()])].some(
    path => {
      const remoteBuffer = remote.get(path);
      const finalBuffer = final.get(path);
      if (!remoteBuffer || !finalBuffer) return remoteBuffer !== finalBuffer;
      return !remoteBuffer.equals(finalBuffer);
    },
  );
  if (remoteDiffers) {
    await client.replaceProject(project, final);
    log(`local -> Overleaf: ${project.name}`);
  }
  state.projects[project.projectId] = {
    last: hashMap(final),
    syncedAt: new Date().toISOString(),
    conflict: hasConflict || undefined,
  };
  saveState(state);
  if (remoteChangedLocal) log(`local files updated for ${project.name}`);
  else if (hasConflict) log(`Overleaf updated from local conflict resolution`);
  else log(`Overleaf and local already aligned: ${project.name}`);
}

async function run(poll) {
  const state = loadState();
  const projects = projectEntries();
  const clients = new Map();
  for (const project of projects) {
    const client = new OverleafClient();
    await client.login();
    clients.set(project.projectId, client);
  }
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  do {
    let retryDelay = Math.max(1, Number(config.pollSeconds) || 5) * 1000;
    for (const project of projects) {
      try {
        await syncOnce(
          project,
          state,
          clients.get(project.projectId),
        );
      } catch (error) {
        if (String(error?.message).includes('429')) {
          retryDelay = 30_000;
        }
        console.error(
          new Date().toISOString(),
          `sync ${project.projectId} failed:`,
          error.stack || error,
        );
      }
    }
    if (poll && !stopping) {
      await sleep(retryDelay);
    }
  } while (poll && !stopping);
}

const [command] = process.argv.slice(2);
if (command === 'bootstrap') {
  const state = loadState();
  for (const project of projectEntries()) {
    const client = new OverleafClient();
    await client.login();
    await syncOnce(project, state, client, true);
  }
} else if (command === 'run') {
  await run(true);
} else if (command === 'once') {
  await run(false);
} else if (command === 'status') {
  const state = loadState();
  for (const project of projectEntries()) {
    console.log(
      JSON.stringify({
        projectId: project.projectId,
        name: project.name,
        workingTree: project.workingTree,
        state: state.projects[project.projectId] ?? null,
      }),
    );
  }
} else {
  console.error('usage: sync.mjs bootstrap | run | once | status');
  process.exitCode = 2;
}

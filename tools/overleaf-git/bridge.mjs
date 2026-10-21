#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath =
  process.env.OVERLEAF_GIT_CONFIG || join(__dirname, 'projects.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const bridgeScript = fileURLToPath(import.meta.url);
const stateDir = resolve(config.stateDir);
const projectsDir = join(stateDir, 'projects');
const lockDir = join(stateDir, 'locks');
const tempDir = join(stateDir, 'tmp');

mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
mkdirSync(lockDir, { recursive: true, mode: 0o700 });
mkdirSync(tempDir, { recursive: true, mode: 0o700 });

const ignoredExtensions = [
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
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function projectConfig(projectId) {
  const project = config.projects[projectId];
  if (!project) fail(`unknown project: ${projectId}`);
  return project;
}

function gitDirFor(projectId) {
  return join(projectsDir, `${projectId}.git`);
}

function projectMetadataFile(projectId) {
  return join(gitDirFor(projectId), 'overleaf-project.json');
}

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    encoding: options.encoding ?? 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: options.maxBuffer ?? 100 * 1024 * 1024,
    stdio: options.stdio,
  });
}

async function withLock(name, fn) {
  const path = join(lockDir, `${name}.lock`);
  let fd;
  for (;;) {
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 5 * 60 * 1000) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(path, { force: true });
  }
}

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(cookies, headers) {
  const values = headers.getSetCookie?.() ?? [];
  for (const raw of values) {
    const first = raw.split(';', 1)[0];
    const index = first.indexOf('=');
    if (index > 0) {
      cookies.set(first.slice(0, index), first.slice(index + 1));
    }
  }
}

function extractCsrf(html, pattern) {
  const match = html.match(pattern);
  return match?.[1] ?? null;
}

class OverleafClient {
  constructor() {
    this.cookies = new Map();
    this.csrf = null;
    this.baseUrl = config.overleafBaseUrl.replace(/\/$/, '');
  }

  async login() {
    this.cookies.clear();
    const loginResponse = await fetch(`${this.baseUrl}/login`, {
      redirect: 'manual',
    });
    storeCookies(this.cookies, loginResponse.headers);
    const html = await loginResponse.text();
    const csrf = extractCsrf(
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
    const body = new URLSearchParams({
      _csrf: csrf,
      email: credentials.email,
      password: credentials.password,
    });
    const response = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: cookieHeader(this.cookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    storeCookies(this.cookies, response.headers);
    if (response.status !== 302 || !this.cookies.has('overleaf.sid')) {
      fail(`Overleaf login failed with HTTP ${response.status}`);
    }
    this.csrf = null;
  }

  async ensureSession() {
    if (!this.cookies.has('overleaf.sid')) {
      await this.login();
    }
  }

  async request(path, options = {}, retry = true) {
    await this.ensureSession();
    const headers = new Headers(options.headers ?? {});
    headers.set('cookie', cookieHeader(this.cookies));
    const response = await fetch(
      path.startsWith('http') ? path : `${this.baseUrl}${path}`,
      {
        ...options,
        headers,
        redirect: 'manual',
      },
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

  async ensureCsrf() {
    if (this.csrf) return this.csrf;
    const projectIds = Object.keys(config.projects);
    const projectId = projectIds[0];
    const response = await this.request(`/project/${projectId}`);
    if (!response.ok) fail(`project page returned HTTP ${response.status}`);
    const html = await response.text();
    this.csrf = extractCsrf(
      html,
      /<meta\s+name="ol-csrfToken"\s+content="([^"]+)"/,
    );
    if (!this.csrf) fail('could not find project CSRF token');
    return this.csrf;
  }

  async joinProject(projectId) {
    const password = readFileSync(config.webApiPasswordFile, 'utf8').trim();
    const auth = Buffer.from(
      `${config.webApiUser}:${password}`,
      'utf8',
    ).toString('base64');
    const credentials = Object.fromEntries(
      readFileSync(config.credentialsFile, 'utf8')
        .split('\n')
        .filter(line => line.includes('='))
        .map(line => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    const userResponse = await this.request(`/project/${projectId}`);
    const userHtml = await userResponse.text();
    const userId = extractCsrf(
      userHtml,
      /<meta\s+name="ol-user_id"\s+content="([^"]+)"/,
    );
    if (!userId) {
      fail(
        `could not determine user id for ${credentials.email}; project access failed`,
      );
    }
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

  async deleteRootEntities(projectId, projectView) {
    const root = projectView.project.rootFolder?.[0];
    if (!root) fail('project has no root folder');
    const csrf = await this.ensureCsrf();
    const groups = [
      ['docs', 'doc'],
      ['fileRefs', 'file'],
      ['folders', 'folder'],
    ];
    for (const [property, type] of groups) {
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

  async uploadFile(projectId, rootFolderId, filePath, relativePath) {
    const csrf = await this.ensureCsrf();
    const form = new FormData();
    const fileBytes = readFileSync(filePath);
    form.append('name', basename(relativePath));
    form.append('relativePath', relativePath.split(sep).join('/'));
    form.append(
      'qqfile',
      new Blob([fileBytes], { type: 'application/octet-stream' }),
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

  async setProjectSettings(projectId, compiler, rootDocId) {
    const csrf = await this.ensureCsrf();
    const response = await this.request(`/project/${projectId}/settings`, {
      method: 'POST',
      headers: {
        'X-CSRF-TOKEN': csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ compiler, rootDocId }),
    });
    if (!response.ok) {
      fail(`project settings returned HTTP ${response.status}`);
    }
  }

  async exportProjectZip(projectId, destination) {
    const response = await this.request(
      `/Project/${projectId}/download/zip`,
    );
    if (!response.ok) {
      fail(`project export returned HTTP ${response.status}`);
    }
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  }
}

function shouldIgnoreFile(path) {
  const name = basename(path);
  if (name === '.git' || name === '.gitignore') return true;
  if (name.startsWith('.')) return true;
  return ignoredExtensions.some(extension => name.endsWith(extension));
}

function walkFiles(root, current = root, result = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const fullPath = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkFiles(root, fullPath, result);
    } else if (entry.isFile() && !shouldIgnoreFile(fullPath)) {
      result.push({
        absolutePath: fullPath,
        relativePath: relative(root, fullPath),
      });
    }
  }
  return result;
}

async function syncDirectoryToOverleaf(projectId, directory) {
  const project = projectConfig(projectId);
  const overleaf = new OverleafClient();
  await overleaf.login();
  await overleaf.ensureCsrf();
  const view = await overleaf.joinProject(projectId);
  const rootFolderId = view.project.rootFolder?.[0]?._id;
  if (!rootFolderId) fail('project root folder id is missing');

  const files = walkFiles(directory).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  if (files.length === 0) fail(`refusing to publish empty directory: ${directory}`);
  if (!files.some(file => file.relativePath === project.mainFile)) {
    fail(`main file ${project.mainFile} is missing from ${directory}`);
  }

  await overleaf.deleteRootEntities(projectId, view);
  const ids = new Map();
  for (const file of files) {
    const entityId = await overleaf.uploadFile(
      projectId,
      rootFolderId,
      file.absolutePath,
      file.relativePath,
    );
    ids.set(file.relativePath.split(sep).join('/'), entityId);
    log(`uploaded ${file.relativePath}`);
  }

  const rootDocId = ids.get(project.mainFile);
  if (!rootDocId) fail(`could not resolve uploaded root document ${project.mainFile}`);
  await overleaf.setProjectSettings(
    projectId,
    project.compiler || 'xelatex',
    rootDocId,
  );
  overleaf.csrf = null;
  log(`published ${files.length} files to Overleaf project ${projectId}`);
}

function ensureBareRepository(projectId) {
  const project = projectConfig(projectId);
  const gitDir = gitDirFor(projectId);
  mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  if (!existsSync(gitDir)) {
    execFileSync('git', [
      'init',
      '--bare',
      `--initial-branch=${project.branch}`,
      gitDir,
    ]);
  }
  runGit([
    '--git-dir',
    gitDir,
    'symbolic-ref',
    'HEAD',
    `refs/heads/${project.branch}`,
  ]);
  writeFileSync(
    projectMetadataFile(projectId),
    JSON.stringify({ projectId, ...project }, null, 2) + '\n',
    { mode: 0o600 },
  );
  const hook = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${OVERLEAF_BRIDGE_SKIP_PUSH:-}" = "1" ]; then
  cat >/dev/null
  exit 0
fi
while read -r old new ref; do
  if [ "$ref" = "refs/heads/${project.branch}" ]; then
    OVERLEAF_GIT_CONFIG="${configPath}" ${process.execPath} "${bridgeScript}" publish "${projectId}" "$new"
  fi
done
`;
  const hookPath = join(gitDir, 'hooks', 'pre-receive');
  writeFileSync(hookPath, hook, { mode: 0o700 });
  chmodSync(hookPath, 0o700);
  return gitDir;
}

async function publishCommit(projectId, revision) {
  const gitDir = ensureBareRepository(projectId);
  await withLock(`project-${projectId}`, async () => {
    const temp = mkdtempSync(join(tempDir, `publish-${projectId}-`));
    try {
      const archive = runGit(
        ['--git-dir', gitDir, 'archive', '--format=tar', revision],
        { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 },
      );
      const archivePath = join(temp, 'tree.tar');
      writeFileSync(archivePath, archive);
      const treePath = join(temp, 'tree');
      mkdirSync(treePath);
      execFileSync('tar', ['-xf', archivePath, '-C', treePath]);
      await syncDirectoryToOverleaf(projectId, treePath);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

function removeSynchronizedFiles(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry === '.git') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      removeSynchronizedFiles(path);
      if (readdirSync(path).length === 0) {
        rmSync(path, { recursive: true, force: true });
      }
    } else if (!shouldIgnoreFile(path)) {
      rmSync(path, { force: true });
    }
  }
}

async function captureOverleaf(projectId) {
  const project = projectConfig(projectId);
  const gitDir = ensureBareRepository(projectId);
  return withLock(`project-${projectId}`, async () => {
    const temp = mkdtempSync(join(tempDir, `capture-${projectId}-`));
    const clone = join(temp, 'clone');
    const zip = join(temp, 'project.zip');
    try {
      runGit([
        'clone',
        '--quiet',
        '--shared',
        '--branch',
        project.branch,
        gitDir,
        clone,
      ]);
      runGit(['config', 'core.fileMode', 'false'], { cwd: clone });
      log(
        `capture clone origin ${runGit(['remote', 'get-url', 'origin'], {
          cwd: clone,
        }).trim()}`,
      );
      removeSynchronizedFiles(clone);

      const overleaf = new OverleafClient();
      await overleaf.login();
      await overleaf.exportProjectZip(projectId, zip);
      execFileSync('unzip', ['-qq', '-o', zip, '-d', clone]);
      for (const file of walkFiles(clone)) {
        if (shouldIgnoreFile(file.absolutePath)) {
          rmSync(file.absolutePath, { force: true });
        }
      }
      const snapshotFiles = walkFiles(clone).length;
      log(`overleaf snapshot has ${snapshotFiles} synchronized files`);
      runGit(['add', '-A'], { cwd: clone });
      try {
        runGit(['diff', '--cached', '--quiet'], {
          cwd: clone,
          stdio: 'ignore',
        });
        log(`no Overleaf changes for ${projectId}`);
        return false;
      } catch {
        // The staged diff is non-empty.
      }
      runGit(
        [
          '-c',
          'user.name=Overleaf Bridge',
          '-c',
          'user.email=overleaf-bridge@localhost',
          'commit',
          '-m',
          `Overleaf snapshot ${new Date().toISOString()}`,
        ],
        { cwd: clone },
      );
      const commit = runGit(['rev-parse', 'HEAD'], { cwd: clone }).trim();
      runGit(['push', 'origin', `HEAD:${project.branch}`, '--quiet'], {
        cwd: clone,
        env: { OVERLEAF_BRIDGE_SKIP_PUSH: '1' },
      });
      const branchHead = runGit(
        ['--git-dir', gitDir, 'rev-parse', project.branch],
        {},
      ).trim();
      log(
        `captured Overleaf changes for ${projectId} commit=${commit} branchHead=${branchHead}`,
      );
      return true;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

async function poll() {
  const interval = Math.max(1, Number(config.pollSeconds) || 3) * 1000;
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  while (!stopping) {
    for (const projectId of Object.keys(config.projects)) {
      try {
        ensureBareRepository(projectId);
        await captureOverleaf(projectId);
      } catch (error) {
        console.error(
          new Date().toISOString(),
          `poll ${projectId} failed:`,
          error.stack || error,
        );
      }
    }
    await sleep(interval);
  }
}

function status() {
  for (const [projectId, project] of Object.entries(config.projects)) {
    const gitDir = gitDirFor(projectId);
    let revision = null;
    try {
      revision = runGit([
        '--git-dir',
        gitDir,
        'rev-parse',
        project.branch,
      ]).trim();
    } catch {}
    console.log(
      JSON.stringify({
        projectId,
        name: project.name,
        workingTree: project.workingTree,
        gitDir,
        branch: project.branch,
        revision,
      }),
    );
  }
}

async function main() {
  const [command, projectId, revision] = process.argv.slice(2);
  switch (command) {
    case 'init':
      for (const id of projectId ? [projectId] : Object.keys(config.projects)) {
        console.log(ensureBareRepository(id));
      }
      break;
    case 'publish':
      await publishCommit(projectId, revision);
      break;
    case 'capture':
      await captureOverleaf(projectId);
      break;
    case 'poll':
      await poll();
      break;
    case 'status':
      status();
      break;
    default:
      console.error(
        'usage: bridge.mjs init [project-id] | publish <project-id> <rev> | capture <project-id> | poll | status',
      );
      process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

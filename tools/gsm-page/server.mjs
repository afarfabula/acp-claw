import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.JSM_PORT || 8820);
const PASSWORD = process.env.JSM_PASSWORD || 'JSMZKAL';
const COOKIE_NAME = 'jsm_auth';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

const sessions = new Map(); // token -> expiresAt

function getSession(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      const token = rest.join('=');
      const expiresAt = sessions.get(token);
      if (expiresAt && expiresAt > Date.now()) return token;
      sessions.delete(token);
    }
  }
  return null;
}

function setSession(res) {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  return token;
}

function clearSession(req, res) {
  const token = getSession(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function serveFile(res, filename) {
  const content = await readFile(path.join(__dirname, filename));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // 登录接口
    if (req.method === 'POST' && url.pathname === '/api/login') {
      let body = {};
      try {
        body = JSON.parse(await readBody(req) || '{}');
      } catch {
        body = {};
      }
      if (typeof body.password === 'string' && body.password.trim() === PASSWORD) {
        setSession(res);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: '密码不对哦，再想想暗号~' }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      clearSession(req, res);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (getSession(req)) {
        await serveFile(res, 'index.html');
      } else {
        await serveFile(res, 'login.html');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Error');
    console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`JSM page server listening on http://${HOST}:${PORT}`);
});

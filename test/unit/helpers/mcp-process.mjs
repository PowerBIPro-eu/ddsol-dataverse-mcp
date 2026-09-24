// Starts build/index.js as a child process and talks JSON-RPC to it over stdio,
// the way an MCP client does. Every server gets its own temporary home, token
// cache and state directory, so tests never touch a developer's real sign-in.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const serverPath = join(repoRoot, 'build', 'index.js');

export function makeTempDir(prefix = 'dvmcp-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** `home` may be prepared by the test (e.g. with cached tokens); it is deleted on close. */
export function startServer({ cwd, env = {}, home = makeTempDir('dvmcp-home-') }) {
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: home,
      HOME: home,
      USERPROFILE: home,
      DATAVERSE_MCP_STATE_DIR: join(home, 'state'),
      DATAVERSE_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
      DATAVERSE_AUTH_MODE: 'device',
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const stdoutLines = [];
  const waiting = new Map();
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return {
    home,
    get stdoutLines() {
      return stdoutLines;
    },
    get stderr() {
      return stderr;
    },
    request(method, params = {}, timeoutMs = 15000) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`Timed out waiting for ${method}. Server stderr:\n${stderr}`));
        }, timeoutMs);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    async initialize() {
      const response = await this.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'unit-test', version: '0.0.0' }
      });
      this.notify('notifications/initialized');
      return response;
    },
    async callTool(name, args = {}) {
      const response = await this.request('tools/call', { name, arguments: args });
      return response.result;
    },
    async close() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.stdin.end();
        child.kill();
        await exited;
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeJsonAtomic } from './auth/token-store.js';
import { normalizeEnvironmentUrl } from './environment-url.js';

// Where the server keeps what belongs to a project and what belongs to a working folder.
//
// - Project config: .dataverse-mcp in the folder the server runs in. It names the
//   solution (and its publisher prefix) and is meant to be committed, so every clone and
//   worktree of the project uses the same solution. The server never rewrites it on its
//   own, and it holds no volatile fields, so it does not churn in git.
// - Working-folder state, outside the repository: only the environment last used in
//   the folder, offered as a suggestion. The environment itself is chosen per session.

export const PROJECT_CONFIG_FILE = '.dataverse-mcp';
const LEGACY_ENVIRONMENT_FILE = '.dataverse-mcp-environment.json';
const LEGACY_PENDING_FILES = ['.dataverse-mcp-pending-org.json', '.dataverse-mcp-pending-globaldisco.json'];

/** Solution context as stored in .dataverse-mcp. */
export interface ProjectSolutionConfig {
  solutionUniqueName: string;
  solutionDisplayName?: string;
  publisherUniqueName?: string;
  publisherDisplayName?: string;
  customizationPrefix?: string;
}

export interface LastEnvironment {
  url: string;
  at: string;
}

/** DATAVERSE_MCP_STATE_DIR, or a per-user state directory. */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATAVERSE_MCP_STATE_DIR) {
    return path.resolve(env.DATAVERSE_MCP_STATE_DIR);
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, 'dataverse-mcp');
  }
  if (env.XDG_STATE_HOME) {
    return path.join(env.XDG_STATE_HOME, 'dataverse-mcp');
  }
  return path.join(env.HOME || os.homedir(), '.local', 'state', 'dataverse-mcp');
}

export class WorkspaceState {
  readonly projectConfigPath: string;
  readonly folderStateDir: string;

  constructor(readonly workspaceDir: string, readonly stateDir: string, private readonly log: (line: string) => void = console.error) {
    this.projectConfigPath = path.join(workspaceDir, PROJECT_CONFIG_FILE);
    const resolved = path.resolve(workspaceDir);
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
    const name = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'root';
    this.folderStateDir = path.join(stateDir, 'workspaces', `${name}-${digest}`);
  }

  readProjectConfig(): ProjectSolutionConfig | null {
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(this.projectConfigPath, 'utf8'));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.log(`Ignoring ${PROJECT_CONFIG_FILE}: it is not valid JSON (${error?.code ?? error?.name ?? 'unknown error'}).`);
      }
      return null;
    }
    if (typeof data?.solutionUniqueName !== 'string' || !data.solutionUniqueName) {
      this.log(`Ignoring ${PROJECT_CONFIG_FILE}: it has no solutionUniqueName.`);
      return null;
    }
    const config: ProjectSolutionConfig = { solutionUniqueName: data.solutionUniqueName };
    for (const key of ['solutionDisplayName', 'publisherUniqueName', 'publisherDisplayName', 'customizationPrefix'] as const) {
      if (typeof data[key] === 'string' && data[key]) {
        config[key] = data[key];
      }
    }
    return config;
  }

  /** Writes .dataverse-mcp with stable fields only, in a fixed order. */
  writeProjectConfig(config: ProjectSolutionConfig): void {
    const stable: ProjectSolutionConfig = { solutionUniqueName: config.solutionUniqueName };
    for (const key of ['solutionDisplayName', 'publisherUniqueName', 'publisherDisplayName', 'customizationPrefix'] as const) {
      if (config[key]) {
        stable[key] = config[key];
      }
    }
    fs.writeFileSync(this.projectConfigPath, `${JSON.stringify(stable, null, 2)}\n`, 'utf8');
  }

  readLastEnvironment(): LastEnvironment | null {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.folderStateDir, 'last-environment.json'), 'utf8'));
      return typeof data?.url === 'string' ? { url: data.url, at: String(data.at ?? '') } : null;
    } catch {
      return null;
    }
  }

  writeLastEnvironment(url: string, at: string = new Date().toISOString()): void {
    try {
      writeJsonAtomic(path.join(this.folderStateDir, 'last-environment.json'), { url, at, folder: path.resolve(this.workspaceDir) });
    } catch (error: any) {
      this.log(`Could not record the last used environment (${error?.code ?? 'unknown error'}).`);
    }
  }

  /**
   * Earlier versions wrote the selected environment and pending sign-ins into the working
   * folder. The environment becomes this folder's last-used suggestion; pending sign-ins
   * (which contain device codes) are deleted, since sign-ins now live with the token cache.
   */
  migrateLegacyFiles(): void {
    const legacyEnvironmentPath = path.join(this.workspaceDir, LEGACY_ENVIRONMENT_FILE);
    if (fs.existsSync(legacyEnvironmentPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyEnvironmentPath, 'utf8'));
        if (typeof data?.dataverseUrl === 'string' && !this.readLastEnvironment()) {
          this.writeLastEnvironment(normalizeEnvironmentUrl(data.dataverseUrl), typeof data.savedAt === 'string' ? data.savedAt : undefined);
        }
      } catch {
        // An unreadable legacy file carries nothing worth keeping.
      }
      this.remove(legacyEnvironmentPath);
      this.log(`Moved ${LEGACY_ENVIRONMENT_FILE} out of the working folder: the environment is now chosen per session.`);
    }
    for (const name of LEGACY_PENDING_FILES) {
      const legacyPendingPath = path.join(this.workspaceDir, name);
      if (fs.existsSync(legacyPendingPath)) {
        this.remove(legacyPendingPath);
        this.log(`Deleted ${name} from the working folder: pending sign-ins are now kept with the token cache.`);
      }
    }
  }

  private remove(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.log(`Could not delete ${path.basename(filePath)} (${error?.code ?? 'unknown error'}).`);
      }
    }
  }
}

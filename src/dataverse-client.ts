import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { exec } from 'child_process';
import { getJson } from './auth/entra-http.js';
import { toDataverseError, withErrorDetailPreference } from './dataverse-error.js';
import { normalizeEnvironmentUrl } from './environment-url.js';
import { LastEnvironment, PROJECT_CONFIG_FILE, WorkspaceState, resolveStateDir } from './workspace-state.js';
import { AuthStatus, GLOBAL_DISCOVERY_RESOURCE, TokenManager } from './auth/token-manager.js';

export interface DataverseConfig {
  dataverseUrl: string;
  clientId: string;
  clientSecret?: string;
  tenantId: string;
  authMode?: 'client_secret' | 'device';
}

export interface SolutionContext {
  solutionUniqueName: string;
  solutionDisplayName?: string;
  publisherUniqueName?: string;
  publisherDisplayName?: string;
  customizationPrefix?: string;
  /** No longer written; kept so older callers still type-check. */
  lastUpdated?: string;
}

export interface DataverseEnvironment {
  friendlyName: string;
  uniqueName: string;
  apiUrl: string;
  environmentId: string;
  region: string;
  state: number;
}

// Best-effort helpers to reduce reliance on reading the MCP server's stderr output.
// Failures here are non-fatal; the console.error output remains the fallback.
function openUrlInBrowser(url: string): void {
  try {
    const platform = process.platform;
    const command = platform === 'win32' ? `start "" "${url}"`
      : platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(command, { shell: platform === 'win32' ? 'cmd.exe' : undefined });
  } catch {
    // Ignore; user can still open the URL manually from stderr output.
  }
}

function copyToClipboard(text: string): void {
  try {
    if (process.platform === 'win32') {
      exec(`echo ${text}| clip`, { shell: 'cmd.exe' });
    } else if (process.platform === 'darwin') {
      exec(`echo ${text} | pbcopy`);
    } else {
      exec(`echo ${text} | xclip -selection clipboard`);
    }
  } catch {
    // Ignore; user can still type the code manually.
  }
}

export type SolutionContextSource = 'project' | 'session';
export type SetSolutionContextOutcome = 'project-created' | 'project-updated' | 'project-default' | 'session-override';

function sameSolution(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class DataverseClient {
  private config: DataverseConfig;
  private httpClient: AxiosInstance;
  private tokens: TokenManager;
  private workspace: WorkspaceState;
  // The solution named by the project's .dataverse-mcp, and an override for this session.
  private projectSolution: SolutionContext | null;
  private sessionSolution: SolutionContext | null = null;
  private solutionClearedForSession = false;
  private verifiedSolutions = new Set<string>();
  // Where the active environment came from: DATAVERSE_URL, or set_dataverse_environment in this session.
  private environmentSource: 'DATAVERSE_URL' | 'session' | null;

  constructor(config: DataverseConfig) {
    this.config = config;
    this.workspace = new WorkspaceState(process.cwd(), resolveStateDir());
    this.workspace.migrateLegacyFiles();

    // The environment is chosen per session; only DATAVERSE_URL preselects one.
    this.config.dataverseUrl = this.normalizeConfiguredUrl(config.dataverseUrl);
    this.environmentSource = this.config.dataverseUrl ? 'DATAVERSE_URL' : null;

    this.tokens = new TokenManager({
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authMode: config.authMode === 'device' || !config.clientSecret ? 'device' : 'client_secret',
      onNewDeviceCode: (verificationUri, userCode) => {
        openUrlInBrowser(verificationUri);
        copyToClipboard(userCode);
      }
    });

    this.projectSolution = this.workspace.readProjectConfig();
    if (this.projectSolution) {
      console.error(`Loaded solution context from ${PROJECT_CONFIG_FILE}: ${this.projectSolution.solutionUniqueName} (${this.projectSolution.solutionDisplayName || 'display name not stored'})`);
    }

    this.httpClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0'
      }
    });

    // Authenticate every request. Writes also ask Dataverse for its error-detail
    // annotations, which it only returns on request.
    this.httpClient.interceptors.request.use(async (config) => {
      config.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;
      if (config.method && config.method.toLowerCase() !== 'get') {
        const existing = config.headers.get('Prefer');
        config.headers.set('Prefer', withErrorDetailPreference(typeof existing === 'string' ? existing : undefined));
      }
      return config;
    });

    // Turn failures into errors with the full Dataverse error details and no request data.
    this.httpClient.interceptors.response.use(
      (response) => response,
      (error) => {
        throw toDataverseError(error);
      }
    );
  }

  // Returns an access token for the active environment, signing in if needed.
  private async ensureAuthenticated(): Promise<string> {
    if (!this.config.dataverseUrl) {
      throw new Error(this.noEnvironmentMessage());
    }
    return this.tokens.getAccessToken(this.config.dataverseUrl);
  }

  private noEnvironmentMessage(): string {
    const lines = [
      'No Dataverse environment is selected for this session. Ask the user which environment to work in, then call set_dataverse_environment (list_dataverse_environments shows the options).'
    ];
    const last = this.workspace.readLastEnvironment();
    if (last) {
      const when = last.at ? ` (selected ${last.at.slice(0, 10)})` : '';
      lines.push(`Last environment used in this folder: ${last.url}${when}. Confirm it with the user before selecting it again.`);
    }
    return lines.join('\n');
  }

  // An unusable URL in the configuration must not stop the server: it starts without
  // an environment and says why.
  private normalizeConfiguredUrl(url: string | undefined): string {
    if (!url) {
      return '';
    }
    try {
      return normalizeEnvironmentUrl(url);
    } catch (error) {
      console.error(`Ignoring the configured Dataverse environment: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  // Lists all Dataverse environments the signed-in user can access, via the Global Discovery Service
  async listEnvironments(): Promise<DataverseEnvironment[]> {
    const accessToken = await this.tokens.getAccessToken(GLOBAL_DISCOVERY_RESOURCE);
    const instancesUrl = `${GLOBAL_DISCOVERY_RESOURCE}/api/discovery/v2.0/Instances`;
    const data = await getJson(instancesUrl, accessToken, `Global Discovery Service (${instancesUrl})`);
    return (data.value || []).map((instance: any) => ({
      friendlyName: instance.FriendlyName,
      uniqueName: instance.UniqueName,
      apiUrl: instance.ApiUrl,
      environmentId: instance.EnvironmentId,
      region: instance.Region,
      state: instance.State
    }));
  }

  // Switches the active environment for this session; accepts a URL, unique name, or friendly name.
  // The choice is not carried into new sessions; it is only remembered as this folder's suggestion.
  async setActiveEnvironment(target: string): Promise<string> {
    let targetUrl = target;
    if (!/^https?:\/\//i.test(target)) {
      const environments = await this.listEnvironments();
      const match = environments.find((e) => e.uniqueName?.toLowerCase() === target.toLowerCase() ||
        e.friendlyName?.toLowerCase() === target.toLowerCase());
      if (!match) {
        throw new Error(`No Dataverse environment found matching '${target}'. Use list_dataverse_environments to see available options.`);
      }
      targetUrl = match.apiUrl;
    }
    const normalizedUrl = normalizeEnvironmentUrl(targetUrl);
    this.config.dataverseUrl = normalizedUrl;
    this.httpClient.defaults.baseURL = `${normalizedUrl}/api/data/v9.2/`;
    this.environmentSource = 'session';
    this.workspace.writeLastEnvironment(normalizedUrl);
    return normalizedUrl;
  }

  /** Sign-in state for get_dataverse_auth_status. Contains no tokens or device codes. */
  getAuthStatus(): { activeEnvironment: string | null } & AuthStatus {
    return { activeEnvironment: this.config.dataverseUrl || null, ...this.tokens.getStatus() };
  }

  getActiveEnvironment(): string {
    return this.config.dataverseUrl;
  }

  /** The active environment, where it came from, and the environment last used in this folder. */
  getEnvironmentInfo(): { url: string | null; source: 'DATAVERSE_URL' | 'session' | null; lastUsedInFolder: LastEnvironment | null } {
    return {
      url: this.config.dataverseUrl || null,
      source: this.environmentSource,
      lastUsedInFolder: this.workspace.readLastEnvironment()
    };
  }

  // Looks a solution up in the active environment; null if it does not exist there.
  private async fetchSolutionContext(solutionUniqueName: string): Promise<SolutionContext | null> {
    const escaped = solutionUniqueName.replace(/'/g, "''");
    const result = await this.get(
      `solutions?$filter=uniquename eq '${escaped}'&$expand=publisherid($select=uniquename,friendlyname,customizationprefix)&$select=uniquename,friendlyname`
    );
    const solution = result?.value?.[0];
    if (!solution) {
      return null;
    }
    const publisher = solution.publisherid;
    return {
      solutionUniqueName: solution.uniquename,
      solutionDisplayName: solution.friendlyname,
      publisherUniqueName: publisher?.uniquename,
      publisherDisplayName: publisher?.friendlyname,
      customizationPrefix: publisher?.customizationprefix
    };
  }

  /**
   * Sets the solution context. Without a project default this creates .dataverse-mcp (to be
   * committed); a solution other than the project default becomes an override for this
   * session only, unless saveAsProjectDefault is set.
   */
  async setSolutionContext(solutionUniqueName: string, options: { saveAsProjectDefault?: boolean } = {}): Promise<SetSolutionContextOutcome> {
    let context: SolutionContext | null;
    try {
      context = await this.fetchSolutionContext(solutionUniqueName);
      if (!context) {
        throw new Error(`Solution '${solutionUniqueName}' not found`);
      }
      const current = this.projectSolution;
      if (current && !options.saveAsProjectDefault && sameSolution(current.solutionUniqueName, context.solutionUniqueName)) {
        this.assertPrefixMatches(current, context, PROJECT_CONFIG_FILE);
      }
    } catch (error) {
      throw new Error(`Failed to set solution context: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    this.solutionClearedForSession = false;
    this.verifiedSolutions.add(this.verificationKey(context.solutionUniqueName));
    const project = this.projectSolution;
    if (!project || options.saveAsProjectDefault) {
      this.workspace.writeProjectConfig(context);
      this.projectSolution = context;
      this.sessionSolution = null;
      return project ? 'project-updated' : 'project-created';
    }
    if (sameSolution(project.solutionUniqueName, context.solutionUniqueName)) {
      this.projectSolution = { ...project, ...context };
      this.sessionSolution = null;
      return 'project-default';
    }
    this.sessionSolution = context;
    return 'session-override';
  }

  private verificationKey(solutionUniqueName: string): string {
    return `${this.config.dataverseUrl}|${solutionUniqueName.toLowerCase()}`;
  }

  private assertPrefixMatches(expected: SolutionContext, actual: SolutionContext, source: string): void {
    const want = expected.customizationPrefix;
    const got = actual.customizationPrefix;
    if (want && got && want.toLowerCase() !== got.toLowerCase()) {
      throw new Error(
        `Solution '${actual.solutionUniqueName}' in ${this.config.dataverseUrl} belongs to a publisher with prefix '${got}', ` +
        `but ${source} expects '${want}'. Check that this is the right environment.`
      );
    }
  }

  /**
   * Confirms that the session's solution exists in the active environment and that its
   * publisher prefix matches what .dataverse-mcp expects, then loads its details. Without
   * an environment there is nothing to check against, and the context is returned as is.
   */
  async verifySolutionContext(): Promise<SolutionContext | null> {
    const current = this.getSolutionContext();
    if (!current || !this.config.dataverseUrl) {
      return current;
    }
    if (this.verifiedSolutions.has(this.verificationKey(current.solutionUniqueName))) {
      return current;
    }
    const source = this.getSolutionContextSource() === 'project' ? PROJECT_CONFIG_FILE : 'this session';
    const fetched = await this.fetchSolutionContext(current.solutionUniqueName);
    if (!fetched) {
      throw new Error(`Solution '${current.solutionUniqueName}' from ${source} does not exist in ${this.config.dataverseUrl}. Check that this is the right environment.`);
    }
    this.assertPrefixMatches(current, fetched, source);
    const verified = { ...current, ...fetched };
    if (this.sessionSolution) {
      this.sessionSolution = verified;
    } else {
      this.projectSolution = verified;
    }
    this.verifiedSolutions.add(this.verificationKey(current.solutionUniqueName));
    return verified;
  }

  /** Whether the session's solution has been checked against the active environment. */
  isSolutionContextVerified(): boolean {
    const current = this.getSolutionContext();
    return !!current && !!this.config.dataverseUrl && this.verifiedSolutions.has(this.verificationKey(current.solutionUniqueName));
  }

  getSolutionContext(): SolutionContext | null {
    if (this.solutionClearedForSession) {
      return null;
    }
    return this.sessionSolution ?? this.projectSolution;
  }

  getSolutionContextSource(): SolutionContextSource | null {
    if (this.solutionClearedForSession) {
      return null;
    }
    return this.sessionSolution ? 'session' : this.projectSolution ? 'project' : null;
  }

  /** The project default from .dataverse-mcp, whether or not it is active in this session. */
  getProjectSolutionContext(): SolutionContext | null {
    return this.projectSolution;
  }

  getSolutionUniqueName(): string | null {
    return this.getSolutionContext()?.solutionUniqueName ?? null;
  }

  /** Clears the solution context for the rest of this session. .dataverse-mcp is not touched. */
  clearSolutionContext(): void {
    this.sessionSolution = null;
    this.solutionClearedForSession = true;
  }

  // Helper method to get headers with solution context
  private getMetadataHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    };

    const solutionUniqueName = this.getSolutionUniqueName();
    if (solutionUniqueName) {
      headers['MSCRM.SolutionUniqueName'] = solutionUniqueName;
    }

    return headers;
  }

  // Helper method to get the customization prefix from the current solution context
  getCustomizationPrefix(): string | null {
    return this.getSolutionContext()?.customizationPrefix || null;
  }

  // Async method to refresh and get customization prefix (for backward compatibility)
  async getCustomizationPrefixAsync(): Promise<string> {
    const context = this.getSolutionContext();
    if (!context) {
      throw new Error('No solution context is set. Please set a solution context using set_solution_context tool to get the customization prefix.');
    }
    if (context.customizationPrefix) {
      return context.customizationPrefix;
    }
    try {
      const fetched = await this.fetchSolutionContext(context.solutionUniqueName);
      if (!fetched) {
        throw new Error(`Solution '${context.solutionUniqueName}' not found`);
      }
      if (!fetched.customizationPrefix) {
        throw new Error(`No customization prefix found for solution '${context.solutionUniqueName}'`);
      }
      return fetched.customizationPrefix;
    } catch (error) {
      throw new Error(`Failed to get customization prefix: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Generic HTTP methods
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<T> {
    const response: AxiosResponse<T> = await this.httpClient.get(endpoint, { params });
    return response.data;
  }

  async post<T = any>(endpoint: string, data?: any, additionalHeaders?: Record<string, string>): Promise<T> {
    const response: AxiosResponse<T> = await this.httpClient.post(endpoint, data, {
      headers: additionalHeaders
    });
    return response.data;
  }

  async patch<T = any>(endpoint: string, data?: any, additionalHeaders?: Record<string, string>): Promise<T> {
    const response: AxiosResponse<T> = await this.httpClient.patch(endpoint, data, {
      headers: additionalHeaders
    });
    return response.data;
  }

  async put<T = any>(endpoint: string, data?: any): Promise<T> {
    const response: AxiosResponse<T> = await this.httpClient.put(endpoint, data);
    return response.data;
  }

  async delete(endpoint: string): Promise<void> {
    await this.httpClient.delete(endpoint);
  }

  // Metadata operations and actions carry the MSCRM.SolutionUniqueName header, so new
  // components are added to the solution from the solution context.
  private async sendSolutionAware<T>(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    endpoint: string,
    options: { data?: any; params?: Record<string, any>; headers?: Record<string, string> } = {}
  ): Promise<AxiosResponse<T>> {
    return this.httpClient.request<T>({
      method,
      url: endpoint,
      data: options.data,
      params: options.params,
      headers: { ...this.getMetadataHeaders(), ...options.headers }
    });
  }

  // Metadata-specific methods
  async getMetadata<T = any>(endpoint: string, params?: Record<string, any>, additionalHeaders?: Record<string, string>): Promise<T> {
    return (await this.sendSolutionAware<T>('get', endpoint, { params, headers: additionalHeaders })).data;
  }

  async postMetadata<T = any>(endpoint: string, data?: any): Promise<T> {
    return (await this.sendSolutionAware<T>('post', endpoint, { data })).data;
  }

  async patchMetadata<T = any>(endpoint: string, data?: any): Promise<T> {
    return (await this.sendSolutionAware<T>('patch', endpoint, { data })).data;
  }

  async putMetadata<T = any>(endpoint: string, data?: any, additionalHeaders?: Record<string, string>): Promise<T> {
    return (await this.sendSolutionAware<T>('put', endpoint, { data, headers: additionalHeaders })).data;
  }

  async deleteMetadata(endpoint: string): Promise<void> {
    await this.sendSolutionAware('delete', endpoint);
  }

  // Action-specific method for calling Dataverse actions
  async callAction<T = any>(actionName: string, data?: any): Promise<T> {
    // Actions should be called with Microsoft.Dynamics.CRM prefix for bound actions
    // Global actions and option set actions don't need the prefix
    const globalActions = [
      'PublishXml', 'PublishAllXml', 'ImportSolution', 'ExportSolution',
      'InsertOptionValue', 'UpdateOptionValue', 'DeleteOptionValue', 'OrderOption',
      'InsertStatusValue', 'UpdateStateValue',
      'AddSolutionComponent', 'RemoveSolutionComponent'
    ];
    const actionUrl = globalActions.includes(actionName) ? actionName : `Microsoft.Dynamics.CRM.${actionName}`;
    return (await this.sendSolutionAware<T>('post', actionUrl, { data })).data;
  }

  // Action-specific method for calling Dataverse actions bound to a specific record
  async callBoundAction<T = any>(entitySetName: string, entityId: string, actionName: string, data?: any): Promise<T> {
    const actionUrl = `${entitySetName}(${entityId})/Microsoft.Dynamics.CRM.${actionName}`;
    return (await this.sendSolutionAware<T>('post', actionUrl, { data })).data;
  }
}

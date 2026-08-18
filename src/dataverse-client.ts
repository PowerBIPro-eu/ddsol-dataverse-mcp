import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface DataverseConfig {
  dataverseUrl: string;
  clientId: string;
  clientSecret?: string;
  tenantId: string;
  authMode?: 'client_secret' | 'device';
}

export interface AuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token?: string;
}

interface PendingDeviceCode {
  scope: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_at: number;
  interval: number;
  lastPollAt: number;
}

export interface DataverseError {
  error: {
    code: string;
    message: string;
    innererror?: {
      message: string;
      type: string;
      stacktrace: string;
    };
  };
}

export interface SolutionContext {
  solutionUniqueName: string;
  solutionDisplayName?: string;
  publisherUniqueName?: string;
  publisherDisplayName?: string;
  customizationPrefix?: string;
  lastUpdated: string;
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

export class DataverseClient {
  private config: DataverseConfig;
  private httpClient: AxiosInstance;
  private authToken: AuthToken | null = null;
  private globalDiscoveryToken: AuthToken | null = null;
  private solutionUniqueName: string | null = null;
  private solutionContext: SolutionContext | null = null;
  private contextFilePath: string;
  private authCacheFilePath: string;
  private activeEnvironmentFilePath: string;

  constructor(config: DataverseConfig) {
    this.config = config;
    this.contextFilePath = path.join(process.cwd(), '.dataverse-mcp');
    this.activeEnvironmentFilePath = path.join(process.cwd(), '.dataverse-mcp-environment.json');

    const persistedEnvironmentUrl = this.loadActiveEnvironment();
    if (persistedEnvironmentUrl) {
      this.config.dataverseUrl = persistedEnvironmentUrl;
    }

    const authCacheKey = Buffer.from(`${config.tenantId}:${config.clientId}:${this.config.dataverseUrl}`).toString('hex');
    this.authCacheFilePath = path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), `dataverse-mcp-auth-${authCacheKey}.json`);
    this.loadAuthToken();

    // Load persisted solution context on startup
    this.loadSolutionContext();
    
    this.httpClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0'
      }
    });

    // Add request interceptor to handle authentication
    this.httpClient.interceptors.request.use(async (config) => {
      await this.ensureAuthenticated();
      if (this.authToken) {
        config.headers.Authorization = `Bearer ${this.authToken.access_token}`;
      }
      return config;
    });

    // Add response interceptor to handle errors
    this.httpClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.data?.error) {
          const dataverseError = error.response.data as DataverseError;
          throw new Error(`Dataverse API Error: ${dataverseError.error.message} (Code: ${dataverseError.error.code})`);
        }
        throw error;
      }
    );
  }

  private loadAuthToken(): void {
    try {
      if (fs.existsSync(this.authCacheFilePath)) {
        const cachedToken = JSON.parse(fs.readFileSync(this.authCacheFilePath, 'utf8'));
        if (cachedToken?.access_token) {
          this.authToken = cachedToken;
        }
      }
    } catch (error) {
      console.error('Failed to load cached Dataverse authentication:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private saveAuthToken(): void {
    try {
      if (this.authToken) {
        fs.writeFileSync(this.authCacheFilePath, JSON.stringify(this.authToken, null, 2), 'utf8');
      }
    } catch (error) {
      console.error('Failed to save cached Dataverse authentication:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private getDataverseScope(): string {
    return `${this.config.dataverseUrl.replace(/\/+$/, '')}/user_impersonation offline_access`;
  }

  private async authenticate(): Promise<AuthToken> {
    try {
      if (this.config.authMode === 'device' || !this.config.clientSecret) {
        return await this.authenticateInteractive('org', this.getDataverseScope());
      }
      return await this.authenticateWithClientSecret();
    } catch (error) {
      throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async authenticateWithClientSecret(): Promise<AuthToken> {
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', this.config.clientId);
    params.append('client_secret', this.config.clientSecret as string);
    params.append('scope', `${this.config.dataverseUrl}/.default`);

    const response = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    return {
      ...response.data,
      expires_at: Date.now() + (response.data.expires_in * 1000) - 60000
    };
  }

  private async requestDeviceCode(scope: string): Promise<any> {
    const deviceCodeUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/devicecode`;
    const deviceParams = new URLSearchParams({
      client_id: this.config.clientId,
      scope
    });
    const deviceResponse = await axios.post(deviceCodeUrl, deviceParams, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const deviceCode = deviceResponse.data;
    console.error('\nDataverse authentication required. Open this URL in a browser:');
    console.error(deviceCode.verification_uri);
    console.error(`Enter code: ${deviceCode.user_code}`);
    if (deviceCode.message) {
      console.error(deviceCode.message);
    }
    // Microsoft Entra's device code endpoint does not support a pre-filled
    // verification_uri_complete, so just open the plain sign-in page and
    // copy the code to the clipboard for a quick paste.
    openUrlInBrowser(deviceCode.verification_uri);
    copyToClipboard(deviceCode.user_code);
    return deviceCode;
  }

  private async pollDeviceCodeToken(deviceCode: any): Promise<AuthToken> {
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const pollParams = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: this.config.clientId,
      device_code: deviceCode.device_code
    });
    const interval = Math.max(Number(deviceCode.interval || 5), 5) * 1000;
    const expiresAt = Date.now() + Number(deviceCode.expires_in || 900) * 1000;
    while (Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      try {
        const tokenResponse = await axios.post(tokenUrl, pollParams, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        return {
          ...tokenResponse.data,
          expires_at: Date.now() + (tokenResponse.data.expires_in * 1000) - 60000
        };
      } catch (error: any) {
        const errorCode = error.response?.data?.error;
        if (errorCode === 'authorization_declined' || errorCode === 'access_denied') {
          throw new Error('Device authentication was denied.');
        }
        if (errorCode === 'expired_token') {
          break;
        }
        // authorization_pending, slow_down, or any other transient/unexpected error:
        // keep polling rather than killing the whole flow on one bad attempt.
        console.error('Device code poll attempt failed, retrying:', error instanceof Error ? error.message : String(error));
        continue;
      }
    }
    throw new Error('Device authentication timed out. Run any Dataverse operation again to start a new login flow.');
  }

  private async authenticateWithDeviceCode(scope: string = this.getDataverseScope()): Promise<AuthToken> {
    const deviceCode = await this.requestDeviceCode(scope);
    return await this.pollDeviceCodeToken(deviceCode);
  }

  // Persists the pending device-code flow to disk (keyed by 'kind' + scope) so it survives
  // the MCP server process being restarted between tool calls (e.g. idle stdio recycling).
  // Each call does at most one poll attempt against the persisted device_code, instead of
  // relying on an in-memory background loop that wouldn't outlive a process restart.
  private getPendingDeviceCodeFilePath(kind: string): string {
    return path.join(process.cwd(), `.dataverse-mcp-pending-${kind}.json`);
  }

  private loadPendingDeviceCode(filePath: string): PendingDeviceCode | null {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch {
      // Ignore a corrupt/partial pending file; a new device code will be requested.
    }
    return null;
  }

  private savePendingDeviceCode(filePath: string, pending: PendingDeviceCode): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify(pending, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to persist pending device code:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private deletePendingDeviceCode(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best effort cleanup.
    }
  }

  private formatSignInMessage(pending: PendingDeviceCode): string {
    return `Sign-in required to continue.\n\nOpen this URL: ${pending.verification_uri}\nEnter code: ${pending.user_code}\n\n(A browser window was opened automatically and the code was copied to your clipboard.)\n\nRun this tool again after completing sign-in.`;
  }

  private async pollDeviceCodeTokenOnce(pending: PendingDeviceCode): Promise<AuthToken> {
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const pollParams = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: this.config.clientId,
      device_code: pending.device_code
    });
    try {
      const tokenResponse = await axios.post(tokenUrl, pollParams, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      return {
        ...tokenResponse.data,
        expires_at: Date.now() + (tokenResponse.data.expires_in * 1000) - 60000
      };
    } catch (error: any) {
      const errorCode = error.response?.data?.error;
      if (errorCode === 'authorization_declined' || errorCode === 'access_denied') {
        throw new Error('Device authentication was denied.');
      }
      if (errorCode === 'expired_token') {
        throw new Error('Device code expired. Run the tool again to start a new sign-in.');
      }
      // authorization_pending, slow_down, or an unexpected/transient error: keep
      // showing the same code rather than failing the whole flow on one bad poll.
      const stillPending: any = new Error('Sign-in still pending.');
      stillPending.stillPending = true;
      throw stillPending;
    }
  }

  private async authenticateInteractive(kind: string, scope: string): Promise<AuthToken> {
    const pendingFilePath = this.getPendingDeviceCodeFilePath(kind);
    let pending = this.loadPendingDeviceCode(pendingFilePath);
    if (pending && (pending.scope !== scope || Date.now() > pending.expires_at)) {
      pending = null;
    }

    if (!pending) {
      const deviceCode = await this.requestDeviceCode(scope);
      pending = {
        scope,
        device_code: deviceCode.device_code,
        user_code: deviceCode.user_code,
        verification_uri: deviceCode.verification_uri,
        expires_at: Date.now() + Number(deviceCode.expires_in || 900) * 1000,
        interval: Math.max(Number(deviceCode.interval || 5), 5) * 1000,
        lastPollAt: 0
      };
      this.savePendingDeviceCode(pendingFilePath, pending);
      throw new Error(this.formatSignInMessage(pending));
    }

    // Respect the minimum polling interval even across separate tool calls/process restarts.
    const waitRemaining = pending.interval - (Date.now() - pending.lastPollAt);
    if (pending.lastPollAt && waitRemaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitRemaining));
    }
    pending.lastPollAt = Date.now();
    this.savePendingDeviceCode(pendingFilePath, pending);

    try {
      const token = await this.pollDeviceCodeTokenOnce(pending);
      this.deletePendingDeviceCode(pendingFilePath);
      return token;
    } catch (error: any) {
      if (error.stillPending) {
        throw new Error(this.formatSignInMessage(pending));
      }
      this.deletePendingDeviceCode(pendingFilePath);
      throw error;
    }
  }

  private async refreshAuthToken(): Promise<AuthToken | null> {
    if (!this.authToken?.refresh_token) {
      return null;
    }
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: this.authToken.refresh_token,
      scope: this.getDataverseScope()
    });
    const response = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    return {
      ...this.authToken,
      ...response.data,
      expires_at: Date.now() + (response.data.expires_in * 1000) - 60000
    };
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.authToken && Date.now() < this.authToken.expires_at) {
      return;
    }
    if (this.authToken?.refresh_token) {
      try {
        this.authToken = await this.refreshAuthToken();
        this.saveAuthToken();
        return;
      } catch {
        console.error('Cached Dataverse login could not be refreshed; starting interactive authentication.');
      }
    }
    this.authToken = await this.authenticate();
    this.saveAuthToken();
  }

  private async ensureGlobalDiscoveryAuthenticated(): Promise<void> {
    const globalDiscoveryScope = 'https://globaldisco.crm.dynamics.com/user_impersonation offline_access';
    if (this.globalDiscoveryToken && Date.now() < this.globalDiscoveryToken.expires_at) {
      return;
    }
    if (this.globalDiscoveryToken?.refresh_token) {
      try {
        this.globalDiscoveryToken = await this.refreshGlobalDiscoveryToken();
        return;
      } catch {
        console.error('Cached Global Discovery login could not be refreshed; starting interactive authentication.');
      }
    }
    this.globalDiscoveryToken = await this.authenticateInteractive('globaldisco', globalDiscoveryScope);
  }

  private async refreshGlobalDiscoveryToken(): Promise<AuthToken | null> {
    if (!this.globalDiscoveryToken?.refresh_token) {
      return null;
    }
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: this.globalDiscoveryToken.refresh_token,
      scope: 'https://globaldisco.crm.dynamics.com/user_impersonation offline_access'
    });
    const response = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    return {
      ...this.globalDiscoveryToken,
      ...response.data,
      expires_at: Date.now() + (response.data.expires_in * 1000) - 60000
    };
  }

  // Lists all Dataverse environments the signed-in user can access, via the Global Discovery Service
  async listEnvironments(): Promise<DataverseEnvironment[]> {
    await this.ensureGlobalDiscoveryAuthenticated();
    const response = await axios.get('https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances', {
      headers: { Authorization: `Bearer ${this.globalDiscoveryToken!.access_token}` }
    });
    return (response.data.value || []).map((instance: any) => ({
      friendlyName: instance.FriendlyName,
      uniqueName: instance.UniqueName,
      apiUrl: instance.ApiUrl,
      environmentId: instance.EnvironmentId,
      region: instance.Region,
      state: instance.State
    }));
  }

  // Switches the active Dataverse environment; accepts a URL, unique name, or friendly name
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
    const normalizedUrl = targetUrl.replace(/\/+$/, '');
    this.config.dataverseUrl = normalizedUrl;
    this.httpClient.defaults.baseURL = `${normalizedUrl}/api/data/v9.2/`;
    this.authToken = null;
    const authCacheKey = Buffer.from(`${this.config.tenantId}:${this.config.clientId}:${normalizedUrl}`).toString('hex');
    this.authCacheFilePath = path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), `dataverse-mcp-auth-${authCacheKey}.json`);
    this.loadAuthToken();
    this.saveActiveEnvironment(normalizedUrl);
    return normalizedUrl;
  }

  getActiveEnvironment(): string {
    return this.config.dataverseUrl;
  }

  private loadActiveEnvironment(): string | null {
    try {
      if (fs.existsSync(this.activeEnvironmentFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.activeEnvironmentFilePath, 'utf8'));
        if (data?.dataverseUrl) {
          return data.dataverseUrl;
        }
      }
    } catch (error) {
      console.warn('Failed to load persisted active Dataverse environment:', error instanceof Error ? error.message : 'Unknown error');
    }
    return null;
  }

  private saveActiveEnvironment(url: string): void {
    try {
      fs.writeFileSync(this.activeEnvironmentFilePath, JSON.stringify({ dataverseUrl: url, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch (error) {
      console.warn('Failed to persist active Dataverse environment:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  // Solution context persistence methods
  private loadSolutionContext(): void {
    try {
      if (fs.existsSync(this.contextFilePath)) {
        const contextData = fs.readFileSync(this.contextFilePath, 'utf8');
        this.solutionContext = JSON.parse(contextData);
        this.solutionUniqueName = this.solutionContext?.solutionUniqueName || null;
        
        if (this.solutionContext) {
          console.log(`Loaded solution context: ${this.solutionContext.solutionUniqueName} (${this.solutionContext.solutionDisplayName || 'Unknown'})`);
        }
      }
    } catch (error) {
      console.warn('Failed to load solution context from .dataverse-mcp file:', error instanceof Error ? error.message : 'Unknown error');
      // Reset context on error
      this.solutionContext = null;
      this.solutionUniqueName = null;
    }
  }

  private saveSolutionContext(): void {
    try {
      if (this.solutionContext) {
        fs.writeFileSync(this.contextFilePath, JSON.stringify(this.solutionContext, null, 2), 'utf8');
      } else {
        // Remove file when context is cleared
        if (fs.existsSync(this.contextFilePath)) {
          fs.unlinkSync(this.contextFilePath);
        }
      }
    } catch (error) {
      console.warn('Failed to save solution context to .dataverse-mcp file:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  // Enhanced solution context methods
  async setSolutionContext(solutionUniqueName: string): Promise<void> {
    try {
      // Fetch solution details to populate context
      const result = await this.get(
        `solutions?$filter=uniquename eq '${solutionUniqueName}'&$expand=publisherid($select=uniquename,friendlyname,customizationprefix)&$select=uniquename,friendlyname`
      );

      if (!result.value || result.value.length === 0) {
        throw new Error(`Solution '${solutionUniqueName}' not found`);
      }

      const solution = result.value[0];
      const publisher = solution.publisherid;

      this.solutionContext = {
        solutionUniqueName: solution.uniquename,
        solutionDisplayName: solution.friendlyname,
        publisherUniqueName: publisher?.uniquename,
        publisherDisplayName: publisher?.friendlyname,
        customizationPrefix: publisher?.customizationprefix,
        lastUpdated: new Date().toISOString()
      };

      this.solutionUniqueName = solutionUniqueName;
      this.saveSolutionContext();
    } catch (error) {
      throw new Error(`Failed to set solution context: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  getSolutionContext(): SolutionContext | null {
    return this.solutionContext;
  }

  getSolutionUniqueName(): string | null {
    return this.solutionUniqueName;
  }

  clearSolutionContext(): void {
    this.solutionUniqueName = null;
    this.solutionContext = null;
    this.saveSolutionContext();
  }

  // Helper method to get headers with solution context
  private getMetadataHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    };

    if (this.solutionUniqueName) {
      headers['MSCRM.SolutionUniqueName'] = this.solutionUniqueName;
    }

    return headers;
  }

  // Helper method to get the customization prefix from the current solution context
  getCustomizationPrefix(): string | null {
    if (!this.solutionContext) {
      return null;
    }
    return this.solutionContext.customizationPrefix || null;
  }

  // Async method to refresh and get customization prefix (for backward compatibility)
  async getCustomizationPrefixAsync(): Promise<string> {
    if (!this.solutionUniqueName) {
      throw new Error('No solution context is set. Please set a solution context using set_solution_context tool to get the customization prefix.');
    }

    // If we have cached prefix, return it
    if (this.solutionContext?.customizationPrefix) {
      return this.solutionContext.customizationPrefix;
    }

    // Otherwise fetch it
    try {
      const result = await this.get(
        `solutions?$filter=uniquename eq '${this.solutionUniqueName}'&$expand=publisherid($select=customizationprefix)`
      );

      if (!result.value || result.value.length === 0) {
        throw new Error(`Solution '${this.solutionUniqueName}' not found`);
      }

      const prefix = result.value[0].publisherid?.customizationprefix;
      if (!prefix) {
        throw new Error(`No customization prefix found for solution '${this.solutionUniqueName}'`);
      }

      return prefix;
    } catch (error) {
      throw new Error(`Failed to get customization prefix: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Generic HTTP methods
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<T> {
    const response: AxiosResponse<T> = await this.httpClient.get(endpoint, { params });
    return response.data;
  }

  async post<T = any>(endpoint: string, data?: any): Promise<T> {
    const response: AxiosResponse<T> = await this.httpClient.post(endpoint, data);
    return response.data;
  }

  async patch<T = any>(endpoint: string, data?: any): Promise<T> {
    const response: AxiosResponse<T> = await this.httpClient.patch(endpoint, data);
    return response.data;
  }

  async put<T = any>(endpoint: string, data?: any): Promise<T> {
    const response: AxiosResponse<T> = await this.httpClient.put(endpoint, data);
    return response.data;
  }

  async delete(endpoint: string): Promise<void> {
    await this.httpClient.delete(endpoint);
  }

  // Metadata-specific methods
  async getMetadata<T = any>(endpoint: string, params?: Record<string, any>): Promise<T> {
    const metadataClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: this.getMetadataHeaders()
    });

    // Add error interceptor
    metadataClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.data?.error) {
          const dataverseError = error.response.data as DataverseError;
          throw new Error(`Dataverse API Error: ${dataverseError.error.message} (Code: ${dataverseError.error.code})`);
        }
        throw error;
      }
    );

    await this.ensureAuthenticated();
    if (this.authToken) {
      metadataClient.defaults.headers.Authorization = `Bearer ${this.authToken.access_token}`;
    }

    const response: AxiosResponse<T> = await metadataClient.get(endpoint, { params });
    return response.data;
  }

  async postMetadata<T = any>(endpoint: string, data?: any): Promise<T> {
    const metadataClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: this.getMetadataHeaders()
    });

    // Add error interceptor
    metadataClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.data?.error) {
          const dataverseError = error.response.data as DataverseError;
          throw new Error(`Dataverse API Error: ${dataverseError.error.message} (Code: ${dataverseError.error.code})`);
        }
        throw error;
      }
    );

    await this.ensureAuthenticated();
    if (this.authToken) {
      metadataClient.defaults.headers.Authorization = `Bearer ${this.authToken.access_token}`;
    }

    const response: AxiosResponse<T> = await metadataClient.post(endpoint, data);
    return response.data;
  }

  async patchMetadata<T = any>(endpoint: string, data?: any): Promise<T> {
    const metadataClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: this.getMetadataHeaders()
    });

    // Add error interceptor
    metadataClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.data?.error) {
          const dataverseError = error.response.data as DataverseError;
          throw new Error(`Dataverse API Error: ${dataverseError.error.message} (Code: ${dataverseError.error.code})`);
        }
        throw error;
      }
    );

    await this.ensureAuthenticated();
    if (this.authToken) {
      metadataClient.defaults.headers.Authorization = `Bearer ${this.authToken.access_token}`;
    }

    const response: AxiosResponse<T> = await metadataClient.patch(endpoint, data);
    return response.data;
  }

  async putMetadata<T = any>(endpoint: string, data?: any, additionalHeaders?: Record<string, string>): Promise<T> {
    const headers = { ...this.getMetadataHeaders(), ...additionalHeaders };
    const metadataClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers
    });

    // Add error interceptor
    metadataClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.data?.error) {
          const dataverseError = error.response.data as DataverseError;
          throw new Error(`Dataverse API Error: ${dataverseError.error.message} (Code: ${dataverseError.error.code})`);
        }
        throw error;
      }
    );

    await this.ensureAuthenticated();
    if (this.authToken) {
      metadataClient.defaults.headers.Authorization = `Bearer ${this.authToken.access_token}`;
    }

    const response: AxiosResponse<T> = await metadataClient.put(endpoint, data);
    return response.data;
  }

  async deleteMetadata(endpoint: string): Promise<void> {
    const metadataClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: this.getMetadataHeaders()
    });

    // Add error interceptor
    metadataClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.data?.error) {
          const dataverseError = error.response.data as DataverseError;
          throw new Error(`Dataverse API Error: ${dataverseError.error.message} (Code: ${dataverseError.error.code})`);
        }
        throw error;
      }
    );

    await this.ensureAuthenticated();
    if (this.authToken) {
      metadataClient.defaults.headers.Authorization = `Bearer ${this.authToken.access_token}`;
    }

    await metadataClient.delete(endpoint);
  }

  // Action-specific method for calling Dataverse actions
  async callAction<T = any>(actionName: string, data?: any): Promise<T> {
    const actionClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0'
      }
    });

    // Add error interceptor
    actionClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.data?.error) {
          const dataverseError = error.response.data as DataverseError;
          throw new Error(`Dataverse API Error: ${dataverseError.error.message} (Code: ${dataverseError.error.code})`);
        }
        throw error;
      }
    );

    await this.ensureAuthenticated();
    if (this.authToken) {
      actionClient.defaults.headers.Authorization = `Bearer ${this.authToken.access_token}`;
    }

    // Actions should be called with Microsoft.Dynamics.CRM prefix for bound actions
    // Global actions and option set actions don't need the prefix
    const globalActions = [
      'PublishXml', 'PublishAllXml', 'ImportSolution', 'ExportSolution',
      'InsertOptionValue', 'UpdateOptionValue', 'DeleteOptionValue', 'OrderOption',
      'AddSolutionComponent', 'RemoveSolutionComponent'
    ];
    const actionUrl = globalActions.includes(actionName) ? actionName : `Microsoft.Dynamics.CRM.${actionName}`;
    const response: AxiosResponse<T> = await actionClient.post(actionUrl, data);
    return response.data;
  }

  // Action-specific method for calling Dataverse actions bound to a specific record
  async callBoundAction<T = any>(entitySetName: string, entityId: string, actionName: string, data?: any): Promise<T> {
    const actionClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0'
      }
    });

    actionClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.data?.error) {
          const dataverseError = error.response.data as DataverseError;
          throw new Error(`Dataverse API Error: ${dataverseError.error.message} (Code: ${dataverseError.error.code})`);
        }
        throw error;
      }
    );

    await this.ensureAuthenticated();
    if (this.authToken) {
      actionClient.defaults.headers.Authorization = `Bearer ${this.authToken.access_token}`;
    }

    const response: AxiosResponse<T> = await actionClient.post(`${entitySetName}(${entityId})/Microsoft.Dynamics.CRM.${actionName}`, data);
    return response.data;
  }
}
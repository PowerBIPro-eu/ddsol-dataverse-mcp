import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getJson } from './auth/entra-http.js';
import { GLOBAL_DISCOVERY_RESOURCE, TokenManager } from './auth/token-manager.js';

export interface DataverseConfig {
  dataverseUrl: string;
  clientId: string;
  clientSecret?: string;
  tenantId: string;
  authMode?: 'client_secret' | 'device';
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
  private tokens: TokenManager;
  private solutionUniqueName: string | null = null;
  private solutionContext: SolutionContext | null = null;
  private contextFilePath: string;
  private activeEnvironmentFilePath: string;

  constructor(config: DataverseConfig) {
    this.config = config;
    this.contextFilePath = path.join(process.cwd(), '.dataverse-mcp');
    this.activeEnvironmentFilePath = path.join(process.cwd(), '.dataverse-mcp-environment.json');

    const persistedEnvironmentUrl = this.loadActiveEnvironment();
    if (persistedEnvironmentUrl) {
      this.config.dataverseUrl = persistedEnvironmentUrl;
    }

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
      config.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;
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

  // Returns an access token for the active environment, signing in if needed.
  private async ensureAuthenticated(): Promise<string> {
    return this.tokens.getAccessToken(this.config.dataverseUrl);
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
          console.error(`Loaded solution context: ${this.solutionContext.solutionUniqueName} (${this.solutionContext.solutionDisplayName || 'Unknown'})`);
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

    metadataClient.defaults.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;

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

    metadataClient.defaults.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;

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

    metadataClient.defaults.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;

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

    metadataClient.defaults.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;

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

    metadataClient.defaults.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;

    await metadataClient.delete(endpoint);
  }

  // Action-specific method for calling Dataverse actions
  async callAction<T = any>(actionName: string, data?: any): Promise<T> {
    const actionClient = axios.create({
      baseURL: `${this.config.dataverseUrl}/api/data/v9.2/`,
      headers: this.getMetadataHeaders()
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

    actionClient.defaults.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;

    // Actions should be called with Microsoft.Dynamics.CRM prefix for bound actions
    // Global actions and option set actions don't need the prefix
    const globalActions = [
      'PublishXml', 'PublishAllXml', 'ImportSolution', 'ExportSolution',
      'InsertOptionValue', 'UpdateOptionValue', 'DeleteOptionValue', 'OrderOption',
      'InsertStatusValue', 'UpdateStateValue',
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
      headers: this.getMetadataHeaders()
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

    actionClient.defaults.headers.Authorization = `Bearer ${await this.ensureAuthenticated()}`;

    const response: AxiosResponse<T> = await actionClient.post(`${entitySetName}(${entityId})/Microsoft.Dynamics.CRM.${actionName}`, data);
    return response.data;
  }
}
// Registers tool modules on a fake MCP server and calls them with a scripted client.
// Arguments go through each tool's zod schema first, as the MCP SDK does, so defaults
// and validation behave exactly as they do for a real client.
import { z } from 'zod';

export function registerTools(registerFunctions, client) {
  const tools = {};
  const server = {
    registerTool(name, definition, handler) {
      tools[name] = { definition, handler };
    }
  };
  for (const register of registerFunctions) {
    register(server, client);
  }
  return {
    async call(name, args = {}) {
      const tool = tools[name];
      if (!tool) throw new Error(`tool ${name} is not registered`);
      return tool.handler(z.object(tool.definition.inputSchema).parse(args));
    },
    schema(name) {
      return tools[name].definition.inputSchema;
    }
  };
}

/** A DataverseClient stand-in: each method records its arguments and returns what `handlers` say. */
export function fakeClient(handlers = {}) {
  const calls = [];
  const methods = [
    'getMetadata', 'postMetadata', 'postMetadataWithResponse', 'putMetadata', 'patchMetadata', 'deleteMetadata',
    'callAction', 'callBoundAction', 'get', 'post', 'patch', 'put', 'delete'
  ];
  const client = {
    calls,
    callsTo(method) {
      return calls.filter((call) => call.method === method).map((call) => call.args);
    },
    getSolutionContext: () => ({ solutionUniqueName: 'contosocore', customizationPrefix: 'cnt' }),
    getSolutionUniqueName: () => 'contosocore',
    getActiveEnvironment: () => 'https://contoso.api.crm4.dynamics.com'
  };
  for (const method of methods) {
    client[method] = async (...args) => {
      calls.push({ method, args });
      return handlers[method] ? handlers[method](...args) : undefined;
    };
  }
  return client;
}

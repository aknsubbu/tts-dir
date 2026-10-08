import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';

/**
 * The MCP connector over Streamable HTTP, inside the dashboard at /mcp. Stateless: each POST
 * gets a fresh server and transport, which call the dashboard's API on the port they came in on.
 * The dashboard's Host and Origin checks run before this, as the MCP spec asks of a local server.
 */
export function mcpHandler() {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this connector is stateless, so only POST is used.' }, id: null });
      return;
    }
    const port = req.socket.localPort;
    const server = createMcpServer({ baseUrl: `http://127.0.0.1:${port}`, linkBase: `http://localhost:${port}` });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP request failed:', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  };
}

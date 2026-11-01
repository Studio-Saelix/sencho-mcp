/**
 * sencho-mcp: a read-only Model Context Protocol server for Sencho.
 *
 * It translates five tools into five fixed Sencho projection endpoints. It holds
 * no authority of its own: the backend gate, the role, the classifier and the
 * node's own capability decide everything.
 *
 * stdout belongs to the protocol. Every diagnostic goes to stderr.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.js';
import { SenchoClient } from './client.js';
import { registerTools } from './tools/index.js';

export const VERSION = '0.1.0';
export const SERVER_NAME = 'sencho-mcp';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`sencho-mcp: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const client = new SenchoClient(config);

  // One server instance per connection; the factory is what lets the transport
  // own the connection's lifetime without sharing handler state between them.
  void serveStdio(() => {
    const server = new McpServer(
      { name: SERVER_NAME, version: VERSION },
      { capabilities: { tools: {} } },
    );
    registerTools(server, client);
    return server;
  });
}

main();

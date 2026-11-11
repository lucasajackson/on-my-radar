/**
 * The MCP client transport the over-the-wire tests connect with.
 *
 * `StreamableHTTPClientTransport` declares `sessionId` as a getter returning
 * `string | undefined`, which is not assignable to the SDK's own `Transport`
 * (`sessionId?: string`) under `exactOptionalPropertyTypes`. Rather than cast
 * it, this hands `Client.connect` a plain `Transport` that delegates to one.
 * It carries no `sessionId`, which is exactly the truth against this server:
 * it is stateless and never issues one, so the client initializes every time.
 *
 * Only tests and `scripts/import-claude-agents.ts` (which talks to this same
 * stateless server) import this; `src/index.ts` never reaches it.
 */
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export function httpTransport(url: URL, options?: StreamableHTTPClientTransportOptions): Transport {
  const inner = new StreamableHTTPClientTransport(url, options);
  const outer: Transport = {
    start: () => inner.start(),
    send: (message, sendOptions) => inner.send(message, sendOptions),
    close: () => inner.close(),
    setProtocolVersion: (version) => {
      inner.setProtocolVersion(version);
    },
  };
  inner.onmessage = (message) => outer.onmessage?.(message);
  inner.onerror = (error) => outer.onerror?.(error);
  inner.onclose = () => outer.onclose?.();
  return outer;
}

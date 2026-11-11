/**
 * The result shapes every MCP tool returns, and the error boundary each one
 * runs inside. Shared by `server.ts` and `agent-repo.ts`.
 */
import { randomUUID } from 'node:crypto';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError } from '../http.js';
import { fenceClientSupplied } from '../services/helpdesk-projection.js';
import { errorMessage, isDatabaseBusy, isMalformedId } from '../errors.js';
import { logger } from '../logger.js';
import { observeMcpTool } from '../metrics.js';

export function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function fail(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

/**
 * The error boundary every tool handler runs inside. It had three defects in
 * five lines, and all three mattered.
 *
 * **It logged nothing.** A database outage inside any tool produced no line in
 * `kubectl logs` at all — the agent got a sentence and the server got silence,
 * which made "Claude can't see my radar" undiagnosable from the pod. Refusals
 * log at `info` (they are the system working) and failures at `error`, both
 * carrying the tool name, because the tool is the first thing you want to know
 * and the stack alone does not always say it.
 *
 * **It narrowed with a cast.** `(err as Error).message` returns `undefined` for
 * a thrown string, and *throws a `TypeError`* for a thrown `null` — inside the
 * catch, so it escaped `guard` and the tool returned no result at all. See
 * `errors.ts`.
 *
 * **It forwarded internal text.** Whatever was thrown went straight to the
 * connected agent, Postgres messages included. An `ApiError` is written to be
 * read by whoever asked — that is what `badRequest`, `forbidden` and
 * `notFound` are for — so its message is surfaced. Anything else is a fault on
 * our side, and the agent gets a sentence it can act on while the detail stays
 * in the log where it belongs.
 */
export async function guard<T>(tool: string, fn: () => T | Promise<T>) {
  // Every tool's result, so the T3 fence on a client's words is a property of
  // the transport, not something each tool must remember (helpdesk-projection).
  return guardResult(tool, async () => ok(fenceClientSupplied(await fn())));
}

/**
 * `guard` for everything that is not a tool: prompts, resources, resource
 * listings and completions.
 *
 * Those answer with a JSON-RPC error rather than a tool result, and the SDK
 * builds that error from whatever was thrown — so a service called bare sent
 * Drizzle's message, the SQL and its parameters included, straight to the
 * client (`prompts/get` with a NUL in the agent name reached Postgres). The
 * rule is the one `guard` applies: an `ApiError`'s words and a schema
 * refusal's first sentence are written to be read and pass through as
 * `InvalidParams`; anything else is logged and becomes one generic sentence.
 */
export async function boundary<T>(handler: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (err instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, err.issues[0]?.message ?? 'Invalid request');
    }
    if (err instanceof ApiError) {
      logger.info({ handler, status: err.status, code: err.code }, 'mcp handler refused');
      throw new McpError(ErrorCode.InvalidParams, errorMessage(err, 'The request failed'));
    }
    if (isMalformedId(err)) {
      throw new McpError(ErrorCode.InvalidParams, 'Not found: an id in the request is not valid.');
    }
    const errorId = `err_${randomUUID()}`;
    logger.error({ err, handler, errorId }, 'mcp handler failed');
    throw new McpError(
      ErrorCode.InternalError,
      `That failed on the server rather than because of anything in the request (error id ${errorId}).`,
    );
  }
}

/**
 * `guard` for a handler that shapes its own result — `load_agent`, whose
 * several text blocks are not one `ok()` payload. Same boundary, one copy.
 */
export async function guardResult<T extends CallToolResult>(
  tool: string,
  fn: () => Promise<T>,
): Promise<(T & { isError?: boolean | undefined }) | ReturnType<typeof fail>> {
  const started = performance.now();
  const done = (outcome: 'ok' | 'refused' | 'failed') =>
    observeMcpTool(tool, outcome, (performance.now() - started) / 1000);
  try {
    const result = await fn();
    done('ok');
    return result;
  } catch (err) {
    if (err instanceof z.ZodError) {
      done('refused');
      return fail(err.issues[0]?.message ?? 'Invalid tool input');
    }
    if (err instanceof ApiError) {
      done('refused');
      logger.info({ tool, status: err.status, code: err.code }, 'mcp tool refused');
      // A stale revision or a held claim carries the blip as it stands, fenced like any result.
      return fail(
        errorMessage(err, 'The request failed') +
          (err.current
            ? `\n\ncurrent blip:\n${JSON.stringify(fenceClientSupplied(err.current), null, 2)}`
            : ''),
      );
    }
    if (isDatabaseBusy(err)) {
      done('failed');
      logger.warn({ tool, err }, 'mcp tool hit a database timeout');
      return fail('The service is busy right now. Wait a few seconds and call this tool again.');
    }
    if (isMalformedId(err)) {
      done('refused');
      logger.info({ tool }, 'mcp tool refused a malformed id');
      return fail(
        'Not found: an id in the request is not a valid id. Pass ids exactly as a list or search tool returned them.',
      );
    }
    done('failed');
    const errorId = `err_${randomUUID()}`;
    logger.error({ err, tool, errorId }, 'mcp tool failed');
    return fail(
      'That failed on the server rather than because of anything in the request. ' +
        `Try again; if it keeps failing the server log has the detail under error id ${errorId}.`,
    );
  }
}

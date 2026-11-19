import { estimateTokens } from '../core/tokens.js';

const PREVIEW_CHARS = 200;

export interface ToolCallEntry {
  name: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  at: Date;
}

function payloadText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value && typeof value === 'object' && 'content' in value) {
    const blocks = (value as { content?: unknown }).content;
    if (Array.isArray(blocks)) {
      const texts = blocks.flatMap((block) =>
        block && typeof block === 'object' && 'text' in block
          ? [String((block as { text: unknown }).text)]
          : [],
      );
      if (texts.length > 0) return texts.join('\n');
    }
  }
  return JSON.stringify(value) ?? String(value);
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS)}…` : collapsed;
}

export function logged<TInput, TResult>(
  name: string,
  handler: (input: TInput) => Promise<TResult> | TResult,
): (input: TInput) => Promise<TResult> {
  return async (input) => {
    const at = new Date();
    try {
      const output = await handler(input);
      process.stderr.write(`${formatToolCall({ name, input, output, at })}\n`);
      return output;
    } catch (error) {
      process.stderr.write(`${formatToolCall({ name, input, error, at })}\n`);
      throw error;
    }
  };
}

export function formatToolCall(entry: ToolCallEntry): string {
  const status = entry.error === undefined ? 'ok' : 'error';
  const payload = status === 'ok' ? entry.output : entry.error;
  const request = payloadText(entry.input);
  const response = payloadText(payload);
  return (
    `[mcp] ${entry.at.toISOString()} ${entry.name} ` +
    `in=${estimateTokens(request)} out=${estimateTokens(response)} ${status} ` +
    `req=${oneLine(request)} res=${oneLine(response)}`
  );
}

export interface RpcErrorEntry {
  at: Date;
  code: number;
  method?: string;
  tool?: string;
  args?: unknown;
  message: string;
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value === null) return 'null';
  return typeof value;
}

export function argShape(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '{}';
  const parts = Object.entries(args as Record<string, unknown>).map(
    ([key, value]) => `${key}:${valueType(value)}`,
  );
  return `{${parts.join(',')}}`;
}

export function formatRpcError(entry: RpcErrorEntry): string {
  const method = entry.method ?? 'unknown';
  const tool = entry.tool ?? 'unknown';
  const message = oneLine(entry.message).replace(/"/g, '\\"');
  return (
    `[mcp] ${entry.at.toISOString()} rpc_error code=${entry.code} ` +
    `method=${method} tool=${tool} args=${argShape(entry.args)} ` +
    `message="${message}"`
  );
}

type JsonRpcMessage = {
  error?: { code?: number; message?: string };
  result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  method?: string;
  params?: { name?: string; arguments?: unknown };
};

function toolErrorText(result: JsonRpcMessage['result']): string | undefined {
  if (!result?.isError || !Array.isArray(result.content)) return undefined;
  const texts = result.content
    .filter((block) => block && typeof block.text === 'string')
    .map((block) => String(block.text));
  return texts.length ? texts.join('\n') : undefined;
}

/** SDK validation failures are returned as tool isError results, not JSON-RPC errors. */
function sdkValidationMessage(text: string): { code: number; message: string } | undefined {
  const match = text.match(/MCP error (-?\d+):\s*(.*)$/s);
  if (!match) return undefined;
  return { code: Number(match[1]), message: match[2] || text };
}

function rpcErrorFields(
  req: JsonRpcMessage | undefined,
): Pick<RpcErrorEntry, 'method' | 'tool' | 'args'> {
  const fields: Pick<RpcErrorEntry, 'method' | 'tool' | 'args'> = {};
  if (req?.method !== undefined) fields.method = req.method;
  if (req?.params?.name !== undefined) fields.tool = req.params.name;
  if (req?.params?.arguments !== undefined) fields.args = req.params.arguments;
  return fields;
}

export function installRpcErrorLogging(
  transport: { send: (...args: never[]) => Promise<void> },
  requestBody: unknown,
): void {
  const originalSend = transport.send.bind(transport) as (
    message: unknown,
    options?: unknown,
  ) => Promise<void>;
  (transport as { send: (message: unknown, options?: unknown) => Promise<void> }).send = async (
    message,
    options,
  ) => {
    const msg = message as JsonRpcMessage;
    const req = requestBody as JsonRpcMessage | undefined;
    const at = new Date();
    const fields = rpcErrorFields(req);

    if (msg?.error && typeof msg.error.code === 'number') {
      process.stderr.write(
        `${formatRpcError({
          at,
          code: msg.error.code,
          ...fields,
          message: msg.error.message ?? 'error',
        })}\n`,
      );
    } else {
      const text = toolErrorText(msg?.result);
      const validation = text ? sdkValidationMessage(text) : undefined;
      if (validation) {
        process.stderr.write(
          `${formatRpcError({
            at,
            code: validation.code,
            ...fields,
            message: validation.message,
          })}\n`,
        );
      }
    }
    return originalSend(message, options);
  };
}

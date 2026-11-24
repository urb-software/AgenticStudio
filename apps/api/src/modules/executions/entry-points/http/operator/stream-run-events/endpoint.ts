import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Controller, Get, Headers, Logger, Param, Query, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { redactSecrets } from '../../../../../../platform/http/redact.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound, tooManyLogStreams } from '../../shared/problems.js';
import { toRunEventResponse } from '../../shared/run-event-response.js';
import { REDACTED } from '../../../../domain/value-objects/log-redaction.js';
import {
  KEEP_ALIVE,
  type RunLogStreamItem,
  StreamRunEventsHandler,
} from '../../../../application/features/stream-run-events/handler.js';
import { LogStreamSlots } from '../../../../application/features/stream-run-events/log-stream-slots.js';
import { StreamSession } from '../../../../application/features/stream-run-events/stream-session.js';
import { StreamRunEventsQueryDto } from './schema.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

/** A `Last-Event-ID` the stream itself sent: a seq (PostgreSQL INTEGER). */
const SEQ = /^\d{1,10}$/;
const SEQ_MAX = 2_147_483_647;

function seqFromHeader(value: string | undefined): number {
  if (value === undefined || !SEQ.test(value)) return 0;
  const seq = Number(value);
  return seq <= SEQ_MAX ? seq : 0;
}

async function writable(response: ServerResponse): Promise<void> {
  const done = new AbortController();
  const options = { signal: done.signal };
  try {
    await Promise.race([
      once(response, 'drain', options).catch(() => undefined),
      once(response, 'close', options).catch(() => undefined),
    ]);
  } finally {
    done.abort();
  }
}

/**
 * Resumes after the larger of `after` and `Last-Event-ID` (a reconnect sends the URL's old
 * `after`). The session is re-checked every 15 s, idle or busy; `X-Accel-Buffering: no` keeps a
 * reverse proxy from buffering.
 */
@ApiTags('runs')
@Controller('runs')
export class StreamRunEventsEndpoint {
  private readonly logger = new Logger(StreamRunEventsEndpoint.name);

  constructor(
    private readonly handler: StreamRunEventsHandler,
    private readonly slots: LogStreamSlots,
    private readonly session: StreamSession,
  ) {}

  @Get(':runId/events/stream')
  @ApiOperation({ operationId: 'streamRunEvents' })
  @ApiProduces('text/event-stream')
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'The last seq received; the stream resumes after the larger of it and `after`.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Server-sent events: `id` is the seq, `data` a RunEvent as JSON; `: keep-alive` comments; `event: end` once the Run is final.',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiProblemResponses({
    400: 'Invalid after',
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    429: `Too many live logs open (${EXECUTIONS_PROBLEM_TYPES.tooManyLogStreams})`,
  })
  async stream(
    @Param('runId') runId: string,
    @Query() query: StreamRunEventsQueryDto,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: unknown,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const after = Math.max(query.after ?? 0, seqFromHeader(lastEventId));
    // The global guard admitted this request, so the session cookie is there and valid.
    const sessionId = this.session.idOf(request) ?? '';
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    let stream: AsyncGenerator<RunLogStreamItem>;
    try {
      ({ stream } = await this.handler.execute({ runId, after, abort: abort.signal }));
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
    const release = this.slots.acquire(sessionId);
    if (!release) throw tooManyLogStreams();
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    let sessionGone = false;
    let sessionCheckedAt = Date.now();
    try {
      for await (const item of stream) {
        if (item === KEEP_ALIVE || Date.now() - sessionCheckedAt >= this.session.checkIntervalMs) {
          sessionCheckedAt = Date.now();
          if (!(await this.session.isActive(sessionId))) {
            // Logged out or expired: close without `end`; the reconnect gets 401.
            sessionGone = true;
            break;
          }
        }
        const chunk =
          item === KEEP_ALIVE
            ? ': keep-alive\n\n'
            : item
                .map((event) => {
                  const data = toRunEventResponse({
                    ...event,
                    redacted: event.text.includes(REDACTED),
                  });
                  return `id: ${event.seq}\ndata: ${JSON.stringify(data)}\n\n`;
                })
                .join('');
        // Backpressure: a slow client catching up on a long log is not buffered in memory.
        if (!response.write(chunk) && !abort.signal.aborted) await writable(response);
      }
      if (!abort.signal.aborted && !sessionGone) response.write('event: end\ndata: {}\n\n');
    } catch (error) {
      // The headers are sent, so no problem response is possible: the stream ends and the
      // client reconnects, catching up from the store.
      this.logger.error(
        `The log stream of run ${runId} failed: ${redactSecrets((error as Error).message)}`,
      );
    } finally {
      release();
      response.end();
    }
  }
}

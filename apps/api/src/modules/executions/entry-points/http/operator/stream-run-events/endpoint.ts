import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Controller, Get, Headers, Logger, Param, Query, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { redactSecrets } from '../../../../../../platform/http/redact.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound, tooManyLogStreams } from '../../shared/problems.js';
import { toRunEventResponse } from '../../shared/run-event-response.js';
import { RunNotFoundError } from '../../../../domain/repositories/run-repository.js';
import { REDACTED } from '../../../../domain/value-objects/log-redaction.js';
import {
  KEEP_ALIVE,
  type RunLogStreamItem,
  StreamRunEventsHandler,
} from '../../../../application/features/stream-run-events/handler.js';
import { LogStreamSlots } from '../../../../application/features/stream-run-events/log-stream-slots.js';
import { StreamSession } from '../../../../application/features/stream-run-events/stream-session.js';
import { StreamRunEventsQueryDto } from './schema.js';

/** A `Last-Event-ID` the stream itself sent: a seq (PostgreSQL INTEGER). */
const SEQ = /^\d{1,10}$/;
const SEQ_MAX = 2_147_483_647;

/** `Last-Event-ID` as a seq, or 0 when absent or not one this stream sent. */
function seqFromHeader(value: string | undefined): number {
  if (value === undefined || !SEQ.test(value)) return 0;
  const seq = Number(value);
  return seq <= SEQ_MAX ? seq : 0;
}

/** Waits until the response can take more (`drain`) or is gone (`close`), leaving no listener. */
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
 * `GET /api/runs/:runId/events/stream?after=<seq>` (Issue #99), behind the global session
 * guard: the Run's log as server-sent events. Each message's `id` is the event's seq and its
 * `data` one `RunEvent` as JSON. It opens with a `: connected` comment, and an idle stream
 * sends a `: keep-alive` comment every 15 s. Every 15 s, idle or busy, it checks that the
 * operator session is still valid (a logout or expiry closes the stream; the client's reconnect
 * then gets 401). A busy stream never idles, so the check is timed (#104, from the #119 review). Once the
 * Run is final and every event is sent, it sends one `end` event and closes; a stream that
 * closes without it was dropped, and the client reconnects. It resumes after the larger of
 * `after` and `Last-Event-ID` (a browser reconnect sends the URL's old `after` with a newer
 * header). At most 5 streams per session and 50 in total are open (429 beyond). Proxies must
 * not buffer it: `X-Accel-Buffering: no` asks nginx not to, and README.md documents the rest.
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
      stream = await this.handler.open(runId, after, abort.signal);
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
    // A first comment tells the client (and any proxy) that the stream is open.
    response.write(': connected\n\n');
    let sessionGone = false;
    let sessionCheckedAt = Date.now();
    try {
      for await (const item of stream) {
        // On every idle tick, and at least once per interval while events keep coming.
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
      // The Run is final and every event was sent (not a dropped connection): the client stops.
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

import type { ServerResponse } from 'node:http';
import { Controller, Get, Headers, Logger, Param, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound } from '../../contracts/http/problems.js';
import { toRunEventResponse } from '../../contracts/http/run-event-response.js';
import { RunNotFoundError } from '../../domain/repositories/run-repository.js';
import { KEEP_ALIVE, type RunLogStreamItem, StreamRunEventsHandler } from './handler.js';
import { StreamRunEventsQueryDto } from './schema.js';

/** A `Last-Event-ID` the stream itself sent: a seq. */
const SEQ = /^\d{1,10}$/;

/**
 * `GET /api/runs/:runId/events/stream?after=<seq>` (Issue #99), behind the global session
 * guard: the Run's log as server-sent events. Each message's `id` is the event's seq and its
 * `data` one `RunEvent` as JSON; an idle stream sends a `: keep-alive` comment every 15 s. It
 * ends once the Run is final and every event is sent. A reconnecting EventSource sends
 * `Last-Event-ID`, so it continues after the last event it received. Proxies must not buffer
 * it: `X-Accel-Buffering: no` asks nginx not to, and README.md documents the rest.
 */
@ApiTags('runs')
@Controller('runs')
export class StreamRunEventsEndpoint {
  private readonly logger = new Logger(StreamRunEventsEndpoint.name);

  constructor(private readonly handler: StreamRunEventsHandler) {}

  @Get(':runId/events/stream')
  @ApiOperation({ operationId: 'streamRunEvents' })
  @ApiProduces('text/event-stream')
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'The last seq received; used when `after` is absent.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Server-sent events: `id` is the seq, `data` a RunEvent as JSON; `: keep-alive` comments.',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiProblemResponses({
    400: 'Invalid after',
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
  })
  async stream(
    @Param('runId') runId: string,
    @Query() query: StreamRunEventsQueryDto,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const after =
      query.after ?? (lastEventId !== undefined && SEQ.test(lastEventId) ? Number(lastEventId) : 0);
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    let stream: AsyncGenerator<RunLogStreamItem>;
    try {
      stream = await this.handler.open(runId, after, abort.signal);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    try {
      for await (const item of stream) {
        if (item === KEEP_ALIVE) {
          response.write(': keep-alive\n\n');
          continue;
        }
        response.write(
          item
            .map(
              (event) => `id: ${event.seq}\ndata: ${JSON.stringify(toRunEventResponse(event))}\n\n`,
            )
            .join(''),
        );
      }
    } catch (error) {
      // The headers are sent, so no problem response is possible: the stream ends and the
      // client reconnects, catching up from the store.
      this.logger.error(`The log stream of run ${runId} failed: ${(error as Error).message}`);
    } finally {
      response.end();
    }
  }
}

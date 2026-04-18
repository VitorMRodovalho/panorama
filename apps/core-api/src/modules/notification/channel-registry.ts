import { Injectable, Logger } from '@nestjs/common';
import type { NotificationEvent } from '@prisma/client';

/**
 * ChannelHandler — one side-effect per registered channel.
 *
 * The handler decides which eventTypes it cares about via `supports`
 * (prefix match, exact match, or regex — whatever the channel
 * wants). The dispatcher invokes matching handlers per event.
 *
 * Each handler throws on failure. The dispatcher catches and records
 * per-channel outcome in `channelResults` without letting one
 * broken channel abort sibling channels.
 */
export interface ChannelHandler {
  /** Stable identifier written into channelResults JSON. */
  readonly name: string;
  /** Returns true iff this handler should run for the event type. */
  supports(eventType: string): boolean;
  /**
   * Performs the side-effect (email send, webhook POST, …). Throws
   * with a meaningful message on failure; the dispatcher records the
   * stringified error in `channelResults[<name>].lastError`.
   */
  handle(event: NotificationEvent): Promise<void>;
}

@Injectable()
export class ChannelRegistry {
  private readonly log = new Logger('ChannelRegistry');
  private readonly handlers: ChannelHandler[] = [];

  register(handler: ChannelHandler): void {
    if (this.handlers.some((h) => h.name === handler.name)) {
      throw new Error(`channel_already_registered:${handler.name}`);
    }
    this.handlers.push(handler);
    this.log.log({ channel: handler.name }, 'channel_registered');
  }

  /**
   * Handlers that want to run for this eventType. Order matches
   * registration order; the dispatcher invokes them in parallel, so
   * ordering doesn't affect correctness — only the log trail.
   */
  handlersFor(eventType: string): ChannelHandler[] {
    return this.handlers.filter((h) => h.supports(eventType));
  }

  /** Total count of registered handlers (for health/diagnostics). */
  size(): number {
    return this.handlers.length;
  }
}

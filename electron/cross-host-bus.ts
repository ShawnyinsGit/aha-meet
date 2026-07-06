// cross-host-bus.ts — lightweight pub/sub for cross-host messaging.
//
// When a meeting has multiple HostGroups (e.g. a Claude Code host and a Codex
// host), they occasionally need to share information — a worker from one
// host wrote a file that the other host's workers depend on, or a decision
// resolved that affects everyone. This bus is the communication channel.
//
// Each HostGroup subscribes on creation; the orchestrator publishes events
// when they occur. Messages are injected into the receiving host's talker
// session as system-level user text.

export interface CrossHostMessage {
  /** Source host group id. */
  from: string;
  /** Target host group id, or '*' for broadcast. */
  to: string;
  /** Message content — injected as user text into the target's talker. */
  text: string;
  /** Optional metadata for structured handling. */
  meta?: {
    kind: 'file-written' | 'decision-resolved' | 'plan-update' | 'general';
    payload?: Record<string, unknown>;
  };
}

export type CrossHostHandler = (msg: CrossHostMessage) => void;

export class CrossHostBus {
  private handlers = new Map<string, Set<CrossHostHandler>>();
  private broadcastHandlers = new Set<CrossHostHandler>();

  /** Subscribe a handler for messages targeting a specific hostId. */
  subscribe(hostId: string, handler: CrossHostHandler): () => void {
    let set = this.handlers.get(hostId);
    if (!set) {
      set = new Set();
      this.handlers.set(hostId, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set?.size === 0) this.handlers.delete(hostId);
    };
  }

  /** Subscribe a handler for ALL messages (observability / logging). */
  subscribeAll(handler: CrossHostHandler): () => void {
    this.broadcastHandlers.add(handler);
    return () => {
      this.broadcastHandlers.delete(handler);
    };
  }

  /** Publish a message. Delivered to the target hostId's handlers + broadcast. */
  publish(msg: CrossHostMessage): void {
    // Targeted handlers
    if (msg.to !== '*') {
      const set = this.handlers.get(msg.to);
      if (set) {
        for (const h of set) {
          try { h(msg); } catch (err) {
            console.warn('[cross-host-bus] handler error:', err);
          }
        }
      }
    } else {
      // Broadcast to all except sender
      for (const [hostId, set] of this.handlers) {
        if (hostId === msg.from) continue;
        for (const h of set) {
          try { h(msg); } catch (err) {
            console.warn('[cross-host-bus] broadcast handler error:', err);
          }
        }
      }
    }

    // Global broadcast handlers
    for (const h of this.broadcastHandlers) {
      try { h(msg); } catch (err) {
        console.warn('[cross-host-bus] broadcast observer error:', err);
      }
    }
  }

  /** Remove all handlers for a hostId (called when a HostGroup is removed). */
  unsubscribeHost(hostId: string): void {
    this.handlers.delete(hostId);
  }

  /** Clear everything (called on orchestrator shutdown). */
  dispose(): void {
    this.handlers.clear();
    this.broadcastHandlers.clear();
  }
}

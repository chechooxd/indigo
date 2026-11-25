/**
 * `useChannel` — React binding over `@indigodb/client/realtime`'s
 * `createChannel()`, using `useSyncExternalStore` with stable snapshot
 * identities (status string + frozen members array).
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  createChannel,
  type BroadcastMessage,
  type ChannelStatus,
  type PresenceMember,
  type RealtimeChannel,
} from "@indigodb/client/realtime";

export interface UseChannelOptions {
  baseUrl: string;
  clientId: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  onBroadcast?: (message: BroadcastMessage) => void;
  enabled?: boolean;
}

export interface UseChannelResult {
  status: ChannelStatus;
  members: readonly PresenceMember[];
  broadcast: <Payload = unknown>(event: string, payload?: Payload) => Promise<{ delivered: number }>;
  track: (state?: Record<string, unknown>) => Promise<PresenceMember | null>;
  untrack: () => Promise<void>;
}

const noop = (): void => {};
const EMPTY_MEMBERS: readonly PresenceMember[] = Object.freeze([]);
const getIdleStatus = (): ChannelStatus => "idle";
const getEmptyMembers = (): readonly PresenceMember[] => EMPTY_MEMBERS;

export function useChannel(
  channelName: string | null | undefined,
  options: UseChannelOptions,
): UseChannelResult {
  const { baseUrl, clientId, headers, fetch: fetchImpl, enabled = true } = options;

  const onBroadcastRef = useRef(options.onBroadcast);
  onBroadcastRef.current = options.onBroadcast;

  const active = enabled && channelName != null;

  const channel = useMemo<RealtimeChannel | null>(() => {
    if (!active || channelName == null) return null;
    return createChannel({
      baseUrl,
      channel: channelName,
      clientId,
      headers,
      fetch: fetchImpl,
    });
  }, [active, channelName, baseUrl, clientId, headers, fetchImpl]);

  useEffect(() => {
    if (!channel) return;
    return channel.onBroadcast("*", (msg) => onBroadcastRef.current?.(msg));
  }, [channel]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!channel) return noop;
      return channel.subscribe(onChange);
    },
    [channel],
  );

  const status = useSyncExternalStore(
    subscribe,
    channel ? channel.getStatus : getIdleStatus,
    getIdleStatus,
  );
  const members = useSyncExternalStore(
    subscribe,
    channel ? channel.getMembers : getEmptyMembers,
    getEmptyMembers,
  );

  const broadcast = useCallback(
    async <Payload = unknown>(event: string, payload?: Payload) => {
      if (!channel) return { delivered: 0 };
      return channel.broadcast(event, payload);
    },
    [channel],
  );

  const track = useCallback(
    async (state?: Record<string, unknown>) => {
      if (!channel) return null;
      return channel.track(state);
    },
    [channel],
  );

  const untrack = useCallback(async () => {
    if (!channel) return;
    await channel.untrack();
  }, [channel]);

  return { status, members, broadcast, track, untrack };
}

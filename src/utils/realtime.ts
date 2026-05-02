import { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

type ChangeHandler = (payload: any) => void;

interface Subscription {
  channel: RealtimeChannel;
  table: string;
  handlers: ChangeHandler[];
}

const subscriptions: Map<string, Subscription> = new Map();

export function subscribeToTable(
  sb: SupabaseClient,
  table: string,
  handler: ChangeHandler,
  filter?: string,
): RealtimeChannel {
  const key = `${table}:${filter || '*'}`;
  const existing = subscriptions.get(key);
  if (existing) {
    existing.handlers.push(handler);
    return existing.channel;
  }

  const channelConfig: any = {
    event: '*',
    schema: 'public',
    table,
  };
  if (filter) channelConfig.filter = filter;

  const channelName = `vault-${table}-${filter || 'all'}-${Date.now()}`;

  const channel = sb
    .channel(channelName)
    .on('postgres_changes', channelConfig, (payload: any) => {
      const sub = subscriptions.get(key);
      if (sub) sub.handlers.forEach(h => h(payload));
    })
    .subscribe();

  subscriptions.set(key, { channel, table, handlers: [handler] });
  return channel;
}

export function unsubscribeAll(sb: SupabaseClient) {
  for (const [, sub] of subscriptions) {
    sb.removeChannel(sub.channel);
  }
  subscriptions.clear();
}

export function removeSubscription(sb: SupabaseClient, table: string, filter?: string) {
  const key = `${table}:${filter || '*'}`;
  const sub = subscriptions.get(key);
  if (sub) {
    sb.removeChannel(sub.channel);
    subscriptions.delete(key);
  }
}

// Presence for collaboration
let presenceChannel: RealtimeChannel | null = null;

export function joinPresence(
  sb: SupabaseClient,
  userId: string,
  userInfo: { email: string; fullName: string },
  onUpdate: (users: any[]) => void,
) {
  if (presenceChannel) sb.removeChannel(presenceChannel);

  presenceChannel = sb.channel('vault-presence', {
    config: { presence: { key: userId } },
  });

  const flushPresenceUsers = () => {
    const state = presenceChannel!.presenceState();
    const users: any[] = [];
    for (const [, presences] of Object.entries(state)) {
      for (const p of presences as any[]) {
        users.push(p);
      }
    }
    onUpdate(users);
  };

  presenceChannel.on('presence', { event: 'sync' }, flushPresenceUsers);
  presenceChannel.on('presence', { event: 'join' }, flushPresenceUsers);
  presenceChannel.on('presence', { event: 'leave' }, flushPresenceUsers);

  presenceChannel.subscribe(async (status: string) => {
    if (status === 'SUBSCRIBED') {
      await presenceChannel!.track({
        user_id: userId,
        email: userInfo.email,
        full_name: userInfo.fullName,
        online_at: new Date().toISOString(),
      });
    }
  });
}

export function leavePresence(sb: SupabaseClient) {
  if (presenceChannel) {
    sb.removeChannel(presenceChannel);
    presenceChannel = null;
  }
}

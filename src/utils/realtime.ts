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
let editingChannel: RealtimeChannel | null = null;

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

export function joinEditingChannel(
  sb: SupabaseClient,
  onUpdate: (payload: {
    user_id: string;
    node_id: string | null;
    email?: string;
    full_name?: string;
    ts: string;
  }) => void,
  onCursor?: (payload: {
    user_id: string;
    node_id: string | null;
    field: string;
    pos: number;
    line?: number;
    col?: number;
    typing: boolean;
    email?: string;
    full_name?: string;
    ts: string;
  }) => void,
) {
  if (editingChannel) sb.removeChannel(editingChannel);
  editingChannel = sb
    .channel('vault-editing')
    .on('broadcast', { event: 'editing-state' }, (payload: any) => {
      onUpdate(payload?.payload || payload);
    })
    .on('broadcast', { event: 'editing-cursor' }, (payload: any) => {
      if (onCursor) onCursor(payload?.payload || payload);
    })
    .subscribe();
}

export async function broadcastEditingState(
  nodeId: string | null,
  userInfo: { user_id: string; email?: string; full_name?: string },
) {
  if (!editingChannel) return;
  await editingChannel.send({
    type: 'broadcast',
    event: 'editing-state',
    payload: {
      user_id: userInfo.user_id,
      email: userInfo.email,
      full_name: userInfo.full_name,
      node_id: nodeId,
      ts: new Date().toISOString(),
    },
  });
}

export async function broadcastEditingCursor(
  data: {
    node_id: string | null;
    field: string;
    pos: number;
    line?: number;
    col?: number;
    typing: boolean;
  },
  userInfo: { user_id: string; email?: string; full_name?: string },
) {
  if (!editingChannel) return;
  await editingChannel.send({
    type: 'broadcast',
    event: 'editing-cursor',
    payload: {
      user_id: userInfo.user_id,
      email: userInfo.email,
      full_name: userInfo.full_name,
      node_id: data.node_id,
      field: data.field,
      pos: data.pos,
      line: data.line,
      col: data.col,
      typing: data.typing,
      ts: new Date().toISOString(),
    },
  });
}

export function leaveEditingChannel(sb: SupabaseClient) {
  if (editingChannel) {
    sb.removeChannel(editingChannel);
    editingChannel = null;
  }
}

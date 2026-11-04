// How many notifications this member has not seen yet, for the badge on the
// Inbox tab. One number shared by whoever asks: the tab bar shows it, and the
// screens that learn something new (Coming Soon reloading, the Inbox being
// opened, a push arriving) tell it to look again.
import { INBOX_DAYS } from '@/lib/inbox';
import { supabase } from '@/lib/supabase';

let count = 0;
const listeners = new Set<() => void>();

function set(next: number) {
  if (next === count) return;
  count = next;
  for (const listener of listeners) listener();
}

export function subscribeUnread(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getUnread = () => count;

/** Asks the server. Best effort: a failure leaves the badge as it was. */
export async function refreshUnread(): Promise<void> {
  try {
    const since = new Date(Date.now() - INBOX_DAYS * 86_400_000).toISOString();
    const { count: unread, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null)
      .gte('created_at', since);
    if (!error) set(unread ?? 0);
  } catch {
    // Offline: keep what we had.
  }
}

/** The Inbox has just shown everything. */
export const clearUnread = () => set(0);

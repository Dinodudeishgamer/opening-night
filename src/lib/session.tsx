// Who is using the app.
//
// Supabase Auth holds this phone's session (an anonymous user, created when
// an invite code was entered here); the database says whether that Auth user
// is linked to a member (whoami). The app needs both, so there are four
// states, not two:
//
//   loading     restoring the saved session
//   signedOut   no Auth session
//   noMember    a session, but no member behind it: access was reset,
//               paused, removed, or moved to another phone
//   member      linked to an active member; `me` says who, and whether they
//               are the organizer
//
// Signing in with an invite ends by linking the two (complete_invite_claim).
// That happens here, once, whenever a fresh session turns out to have an
// invite waiting, so the screens never have to think about it.
import type { Session } from '@supabase/supabase-js';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { completeInviteClaim, listMembers, whoami } from '@/lib/api';
import { registerThisDevice, unregisterThisDevice } from '@/lib/push';
import { supabase } from '@/lib/supabase';
import type { Me, Member } from '@/lib/types';

type Status = 'loading' | 'signedOut' | 'noMember' | 'member';

interface SessionValue {
  status: Status;
  me: Me | null;
  isOwner: boolean;
  /** Every member, past and present, for putting names and faces to ids. */
  members: Member[];
  memberById: (id: string | null | undefined) => Member | undefined;
  /** Re-reads who the caller is and the member list. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  // Guards against an older resolve finishing after a newer one.
  const generation = useRef(0);

  const resolve = useCallback(async (session: Session | null) => {
    const mine = ++generation.current;
    if (!session) {
      setMe(null);
      setMembers([]);
      setStatus('signedOut');
      return;
    }
    try {
      let who = await whoami();
      if (who.outcome === 'no_member' && who.pending_invite) {
        await completeInviteClaim();
        who = await whoami();
      }
      if (mine !== generation.current) return;
      if (who.outcome !== 'ok') {
        setMe(null);
        setStatus('noMember');
        return;
      }
      setMe({ member_id: who.member_id, first_name: who.first_name, last_initial: who.last_initial, role: who.role });
      setStatus('member');
      setMembers(await listMembers());
      void registerThisDevice();
    } catch {
      // Offline at launch, or the server is unreachable: keep whoever we
      // already knew about rather than throwing a signed-in member out.
      if (mine === generation.current) setStatus((current) => (current === 'loading' ? 'noMember' : current));
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => resolve(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // Token refreshes do not change who anyone is.
      if (event === 'TOKEN_REFRESHED') return;
      // Deferred: Supabase holds a lock while this callback runs, and resolve() calls back into it.
      setTimeout(() => void resolve(session), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [resolve]);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await resolve(data.session);
  }, [resolve]);

  const signOut = useCallback(async () => {
    await unregisterThisDevice();
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<SessionValue>(() => {
    const byId = new Map(members.map((member) => [member.id, member]));
    return {
      status,
      me,
      isOwner: me?.role === 'owner',
      members,
      memberById: (id) => (id ? byId.get(id) : undefined),
      refresh,
      signOut,
    };
  }, [status, me, members, refresh, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

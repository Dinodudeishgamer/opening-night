import { useEffect, useState } from 'react';

import { Avatar } from '@/components/ui/avatar';
import { memberName } from '@/lib/format';
import { avatarUrl } from '@/lib/images';
import type { Member } from '@/lib/types';

/**
 * A member's face: their photo (through a signed URL), their emoji, or their
 * initial. Photo avatars start as the initial and swap in once the URL is
 * ready, so a slow network never leaves an empty circle.
 */
export function MemberAvatar({ member, size = 40, prominent }: { member: Member | undefined; size?: number; prominent?: boolean }) {
  const path = member?.avatar_kind === 'photo' ? member.avatar_path : null;
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setPhoto(null);
    if (path) {
      avatarUrl(path).then((url) => {
        if (current) setPhoto(url);
      });
    }
    return () => {
      current = false;
    };
  }, [path]);

  const avatar = photo ?? (member?.avatar_kind === 'emoji' ? member.avatar_emoji : null);
  return (
    <Avatar
      name={member ? memberName(member) : '?'}
      avatar={avatar}
      size={size}
      prominent={prominent}
      muted={member !== undefined && member.status !== 'active'}
    />
  );
}

/** Guests have no account and so no avatar of their own: a muted initial. */
export function GuestAvatar({ name, size = 40 }: { name: string; size?: number }) {
  return <Avatar name={name} size={size} muted />;
}

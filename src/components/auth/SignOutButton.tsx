'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { LogOut, Loader2 } from 'lucide-react';

/**
 * Client-side sign out. NextAuth v5 requires a CSRF-protected POST, which the
 * `signOut()` helper performs for us; a plain <form> to /api/auth/signout does
 * not carry the token and silently fails.
 */
export default function SignOutButton({ className = 'btn-destructive w-full' }: { className?: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void signOut({ callbackUrl: '/' });
      }}
    >
      {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />} Sign out
    </button>
  );
}

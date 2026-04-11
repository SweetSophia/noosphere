"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={() => signOut({ callbackUrl: "/wiki" })}
    >
      Sign Out
    </button>
  );
}

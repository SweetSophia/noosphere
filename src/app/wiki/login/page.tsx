"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

function getSafeCallbackUrl(rawCallbackUrl: string | null) {
  if (!rawCallbackUrl) return "/wiki";

  try {
    const callbackUrl = new URL(rawCallbackUrl, window.location.origin);
    const isWikiPath =
      callbackUrl.pathname === "/wiki" || callbackUrl.pathname.startsWith("/wiki/");
    const isLoginPath = callbackUrl.pathname === "/wiki/login";

    // Only redirect after login to local wiki pages to avoid open redirects.
    if (callbackUrl.origin !== window.location.origin || !isWikiPath || isLoginPath) {
      return "/wiki";
    }

    return `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`;
  } catch {
    return "/wiki";
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email or password.");
    } else {
      const callbackUrl = getSafeCallbackUrl(
        new URLSearchParams(window.location.search).get("callbackUrl")
      );
      router.push(callbackUrl);
      router.refresh();
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Sign In</h1>
        <p>Access the Noosphere wiki to read and edit articles.</p>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: "100%", justifyContent: "center" }}
            disabled={loading}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

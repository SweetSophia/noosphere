"use client";

import { type FormEvent, type ReactNode, useState, useTransition } from "react";

export function ArticleWriteForm({
  action,
  feedbackAction,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  feedbackAction: (formData: FormData) => Promise<string | void>;
  children?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const message = await feedbackAction(formData);
      if (message) setError(message);
    });
  }

  return (
    <form action={action} onSubmit={submit} aria-busy={pending}>
      {error && <p role="alert" className="alert alert-error">{error}</p>}
      {children}
    </form>
  );
}

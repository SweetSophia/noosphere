"use client";

interface RestoreArticleFormProps {
  action: (formData: FormData) => void | Promise<void>;
  articleId: string;
  className?: string;
}

export function RestoreArticleForm({ action, articleId, className = "btn btn-secondary btn-sm" }: RestoreArticleFormProps) {
  return (
    <form action={action}>
      <input type="hidden" name="articleId" value={articleId} />
      <button type="submit" className={className}>
        Restore
      </button>
    </form>
  );
}

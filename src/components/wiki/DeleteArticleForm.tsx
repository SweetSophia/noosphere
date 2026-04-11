"use client";

interface DeleteArticleFormProps {
  action: (formData: FormData) => void | Promise<void>;
  articleId: string;
  className?: string;
}

export function DeleteArticleForm({ action, articleId, className = "btn btn-danger btn-sm" }: DeleteArticleFormProps) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        const confirmed = window.confirm("Move this article to trash? It will be hidden from the wiki, but not permanently deleted.");
        if (!confirmed) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="articleId" value={articleId} />
      <button type="submit" className={className}>
        Move to Trash
      </button>
    </form>
  );
}

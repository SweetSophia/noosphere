'use client';

type DeleteAction = (formData: FormData) => Promise<void>;

interface DeleteTagButtonProps {
  tagId: string;
  tagName: string;
  articleCount: number;
  deleteAction: DeleteAction;
}

export function DeleteTagButton({ tagId, tagName, articleCount, deleteAction }: DeleteTagButtonProps) {
  return (
    <form action={deleteAction} className="inline-form">
      <input type="hidden" name="id" value={tagId} />
      <button
        type="submit"
        className="btn btn-danger btn-sm"
        disabled={articleCount > 0}
        title={articleCount > 0 ? `In use by ${articleCount} article(s)` : "Delete tag"}
        onClick={(e) => {
          if (articleCount > 0) {
            e.preventDefault();
            alert(`Tag "${tagName}" is used by ${articleCount} article(s). Remove it from articles first.`);
            return;
          }
          if (!confirm(`Delete tag "${tagName}"? This cannot be undone.`)) {
            e.preventDefault();
          }
        }}
      >
        Delete
      </button>
    </form>
  );
}

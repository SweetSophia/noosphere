'use client';

type DeleteAction = (formData: FormData) => Promise<void>;

interface DeleteTopicButtonProps {
  topicId: string;
  topicName: string;
  deleteAction: DeleteAction;
  /** Allowed post-delete path. Only `/wiki` is accepted by the server action. */
  next?: "/wiki";
}

export function DeleteTopicButton({ topicId, topicName, deleteAction, next }: DeleteTopicButtonProps) {
  return (
    <form action={deleteAction} className="inline-form">
      <input type="hidden" name="id" value={topicId} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <button
        type="submit"
        className="btn btn-danger btn-sm"
        onClick={(e) => {
          if (!confirm(`Delete topic "${topicName}"? This cannot be undone.`)) {
            e.preventDefault();
          }
        }}
      >
        Delete
      </button>
    </form>
  );
}

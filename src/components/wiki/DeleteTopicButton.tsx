'use client';

type DeleteAction = (formData: FormData) => Promise<void>;

interface DeleteTopicButtonProps {
  topicId: string;
  topicName: string;
  deleteAction: DeleteAction;
}

export function DeleteTopicButton({ topicId, topicName, deleteAction }: DeleteTopicButtonProps) {
  return (
    <form action={deleteAction} className="inline-form">
      <input type="hidden" name="id" value={topicId} />
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

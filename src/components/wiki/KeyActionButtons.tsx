'use client';

type ApiKeyAction = (formData: FormData) => Promise<void>;

interface KeyActionButtonsProps {
  keyId: string;
  keyName: string;
  isRevoked: boolean;
  revokeAction: ApiKeyAction;
  rotateAction: ApiKeyAction;
  deleteAction: ApiKeyAction;
}

export function KeyActionButtons({
  keyId,
  keyName,
  isRevoked,
  revokeAction,
  rotateAction,
  deleteAction,
}: KeyActionButtonsProps) {
  if (isRevoked) {
    return (
      <div className="key-action-buttons">
        <form action={deleteAction}>
          <input type="hidden" name="id" value={keyId} />
          <button
            type="submit"
            className="btn btn-danger btn-sm"
            onClick={(e) => {
              if (
                !confirm(
                  `Permanently delete key "${keyName}"? This cannot be undone.`
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            Delete
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="key-action-buttons">
      {/* Rotate — creates new key, revokes this one */}
      <form action={rotateAction}>
        <input type="hidden" name="id" value={keyId} />
        <button
          type="submit"
          className="btn btn-outline-warning btn-sm"
          onClick={(e) => {
            if (
              !confirm(
                `Rotate key "${keyName}"? A new key will be generated and shown, and this one will be revoked.`
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          Rotate
        </button>
      </form>
      {/* Revoke — invalidates immediately */}
      <form action={revokeAction}>
        <input type="hidden" name="id" value={keyId} />
        <button
          type="submit"
          className="btn btn-outline-danger btn-sm"
          onClick={(e) => {
            if (
              !confirm(
                `Revoke key "${keyName}"? It will stop working immediately.`
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          Revoke
        </button>
      </form>
    </div>
  );
}

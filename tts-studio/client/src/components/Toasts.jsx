export default function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind || 'info'}`}>
          <span className="toast-text">{t.text}</span>
          {t.actions?.length > 0 && (
            <span className="toast-actions">
              {t.actions.map((a) => (
                <button
                  key={a.label}
                  className="link"
                  onClick={() => {
                    dismiss(t.id);
                    a.run();
                  }}
                >
                  {a.label}
                </button>
              ))}
            </span>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

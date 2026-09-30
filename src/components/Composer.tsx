/**
 * Writing a message or a comment. The box grows with what is typed (up to a
 * few lines, then scrolls), keeps line breaks, and keeps the draft if a send
 * fails. On a phone Return is a new line and the button sends; with a
 * keyboard, Return sends a chat message and Shift+Return is a new line
 * (for comments, Cmd/Ctrl+Return sends).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconSend } from './Icons';

const MAX_CHARS = 5000;

export function Composer({
  label,
  placeholder,
  onSend,
  enterSends = false,
  autoFocus = false,
}: {
  label: string;
  placeholder: string;
  /** Resolves true once sent, so the box clears; false keeps the draft. */
  onSend: (text: string) => Promise<boolean>;
  enterSends?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 168)}px`;
  }, [text]);

  useEffect(() => {
    // Not on a phone: bringing up the keyboard uninvited covers the conversation.
    if (autoFocus && window.matchMedia?.('(pointer: fine)').matches) box.current?.focus();
  }, [autoFocus]);

  const trimmed = text.trim();
  const tooLong = text.length > MAX_CHARS;

  const send = async () => {
    if (!trimmed || tooLong || sending) return;
    setSending(true);
    try {
      if (await onSend(text)) setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={box}
        className="composer__input"
        aria-label={label}
        placeholder={placeholder}
        rows={1}
        value={text}
        enterKeyHint={enterSends ? 'send' : 'enter'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          const keyboard = window.matchMedia?.('(pointer: fine)').matches;
          const wants = enterSends ? keyboard && !e.shiftKey : e.metaKey || e.ctrlKey;
          if (wants) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button
        className="btn btn--primary btn--icon composer__send"
        onClick={() => void send()}
        disabled={!trimmed || tooLong || sending}
        aria-label="Send"
        // Keeps the keyboard up on a phone: the tap does not steal focus from the box.
        onMouseDown={(e) => e.preventDefault()}
      >
        <IconSend />
      </button>
      {tooLong ? <div className="composer__warn">{text.length - MAX_CHARS} characters over the limit</div> : null}
    </div>
  );
}

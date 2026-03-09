import React, { useEffect, useRef } from "react";
import MessageBubble from "./MessageBubble";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  transcript?: string;
  createdAt: number;
};

export default function ChatPane({
  messages,
  onPopoutAssistant
}: {
  messages: ChatMessage[];
  onPopoutAssistant?: (msg: ChatMessage) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);

  function isNearBottom(el: HTMLDivElement): boolean {
    const threshold = 72;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceToBottom <= threshold;
  }

  function handleScroll() {
    const el = ref.current;
    if (!el) return;
    shouldAutoScrollRef.current = isNearBottom(el);
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!shouldAutoScrollRef.current) return;

    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="chat" ref={ref} onScroll={handleScroll}>
      {messages.map(m => (
        <MessageBubble
          key={m.id}
          msg={m}
          onPopout={m.role === "assistant" ? () => onPopoutAssistant?.(m) : undefined}
        />
      ))}
    </div>
  );
}

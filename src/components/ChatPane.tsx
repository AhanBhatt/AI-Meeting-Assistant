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

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="chat" ref={ref}>
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

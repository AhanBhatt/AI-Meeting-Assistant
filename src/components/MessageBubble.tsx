import React from "react";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  transcript?: string;
  createdAt: number;
};

export default function MessageBubble({ msg, onPopout }: { msg: ChatMessage; onPopout?: () => void }) {
  const cls = msg.role === "user" ? "row user" : "row ai";

  return (
    <div className={cls}>
      <div className="bubble">
        {msg.text}
        {msg.role === "assistant" && msg.transcript && (
          <details>
            <summary>Transcript used</summary>
            <div style={{ marginTop: 8, whiteSpace: "pre-wrap", lineHeight: 1.35 }}>
              {msg.transcript}
            </div>
          </details>
        )}
        <div className="bubbleFooter">
          <div className="meta">{new Date(msg.createdAt).toLocaleTimeString()}</div>
          {msg.role === "assistant" && onPopout && (
            <button className="bubbleAction" onClick={onPopout} title="Pop this response into a sticky note">
              Pop out
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

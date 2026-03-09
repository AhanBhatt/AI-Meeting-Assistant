import React, { useState } from "react";

type Source = { id: string; name: string; thumb: string };

export default function WindowPicker({
  sources,
  selectedSourceId,
  onPick
}: {
  sources: Source[];
  selectedSourceId: string | null;
  onPick: (src: Source) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--panel2)" }}>
      <div style={{ padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          Pick a window to mirror + capture (Zoom, browser, IDE...)
        </div>
        <button className="pill" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 10,
            padding: 12,
            maxHeight: 280,
            overflow: "auto"
          }}
        >
          {sources.map((s) => (
            <button
              key={s.id}
              className="pill"
              onClick={() => onPick(s)}
              style={{
                textAlign: "left",
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: 10,
                borderColor: s.id === selectedSourceId ? "#3a3a3a" : "var(--border)"
              }}
            >
              <img
                src={s.thumb}
                style={{ width: 120, height: 74, borderRadius: 10, border: "1px solid var(--border)", objectFit: "cover" }}
              />
              <div style={{ fontSize: 13, lineHeight: 1.2 }}>
                <div style={{ fontWeight: 700 }}>{s.name}</div>
                <div style={{ color: "var(--muted)", marginTop: 6 }}>ID: {s.id.slice(0, 18)}...</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

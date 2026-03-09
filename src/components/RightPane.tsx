import React, { useEffect, useRef } from "react";
import WindowPicker from "./WindowPicker";

type Source = { id: string; name: string; thumb: string };

export default function RightPane({
  sources,
  selectedSourceId,
  onPick,
  stream,
  isCapturing,
  uploadOnAskCount
}: {
  sources: Source[];
  selectedSourceId: string | null;
  onPick: (src: Source) => void;
  stream: MediaStream | null;
  isCapturing: boolean;
  uploadOnAskCount: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    if (!stream) return;

    videoRef.current.srcObject = stream;
    videoRef.current.play().catch(() => {});
  }, [stream]);

  return (
    <div className="rightPane">
      <WindowPicker sources={sources} selectedSourceId={selectedSourceId} onPick={onPick} />

      <div className="videoWrap">
        <video ref={videoRef} muted />
        <div className="overlayBadge">
          {selectedSourceId ? (
            <>
              {isCapturing ? "Recording (2s pre-roll included)" : "Ready"}
              {uploadOnAskCount > 0 ? ` - Upload-on-ask: ${uploadOnAskCount} file(s)` : ""}
            </>
          ) : (
            "Select a window to mirror + capture"
          )}
        </div>
      </div>
    </div>
  );
}


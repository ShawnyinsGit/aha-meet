import { ReactNode, RefObject } from 'react';
import type { ScreenShareState } from '../hooks/useScreenShare';

interface ScreenStageProps {
  share: ScreenShareState;
  videoRef: RefObject<HTMLVideoElement>;
  onPickSource: () => void;
  onStopShare: () => void;
  defaultContent: ReactNode;
}

export function ScreenStage({ share, videoRef, onPickSource: _onPickSource, onStopShare, defaultContent }: ScreenStageProps) {
  return (
    <div className={`stage ${share.active ? 'stage-sharing' : 'stage-default'}`}>
      {!share.active && <div className="stage-default-content">{defaultContent}</div>}

      {share.active && (
        <>
          <video
            ref={videoRef}
            className="stage-video"
            autoPlay
            playsInline
            muted
          />
          <div className="stage-banner">
            <span className="stage-banner-dot" />
            Sharing your screen · {share.sourceName}
            <button className="stage-banner-stop" onClick={onStopShare}>Stop</button>
          </div>
        </>
      )}

      {share.error && !share.active && (
        <div className="stage-error-floating">{share.error}</div>
      )}
    </div>
  );
}

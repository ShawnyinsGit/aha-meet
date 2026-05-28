import { ReactNode, RefObject } from 'react';
import type { ScreenShareState } from '../hooks/useScreenShare';
import type { DeliverySnapshot } from '../lib/meeting-store';
import { DocumentStage } from './DocumentStage';

interface ScreenStageProps {
  share: ScreenShareState;
  videoRef: RefObject<HTMLVideoElement>;
  onPickSource: () => void;
  onStopShare: () => void;
  defaultContent: ReactNode;
  /** When non-null and the user isn't currently screen-sharing, the stage
   *  swaps to the delivery acceptance panel instead of the default content. */
  delivery: DeliverySnapshot | null;
  sessionId: string | null;
  onAcceptDelivery: () => void;
  onReviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
}

export function ScreenStage({
  share,
  videoRef,
  onPickSource: _onPickSource,
  onStopShare,
  defaultContent,
  delivery,
  sessionId,
  onAcceptDelivery,
  onReviseDelivery,
}: ScreenStageProps) {
  // Screen share wins (live video is more urgent than a static deliverable).
  // Otherwise prefer a staged delivery over the default participant grid.
  const showDelivery = !share.active && delivery !== null;
  return (
    <div
      className={`stage ${share.active ? 'stage-sharing' : showDelivery ? 'stage-delivery' : 'stage-default'}`}
    >
      {!share.active && !showDelivery && (
        <div className="stage-default-content">{defaultContent}</div>
      )}

      {showDelivery && delivery && (
        <div className="stage-delivery-content">
          <DocumentStage
            delivery={delivery}
            sessionId={sessionId}
            onAccept={onAcceptDelivery}
            onRevise={onReviseDelivery}
          />
        </div>
      )}

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

import { ReactNode, RefObject } from 'react';
import type { ScreenShareState } from '../hooks/useScreenShare';
import type { DeliverySnapshot } from '../lib/meeting-store';
import { DeliveryViewer } from './DeliveryViewer';
import { FileViewer } from './FileViewer';

interface ScreenStageProps {
  share: ScreenShareState;
  videoRef: RefObject<HTMLVideoElement>;
  onPickSource: () => void;
  onStopShare: () => void;
  defaultContent: ReactNode;
  delivery: DeliverySnapshot | null;
  sessionId: string | null;
  onAcceptDelivery: () => void;
  onReviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
  aiSpeaking?: boolean;
  viewingFile?: { relativePath: string } | null;
  onCloseFileView?: () => void;
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
  aiSpeaking = false,
  viewingFile,
  onCloseFileView,
}: ScreenStageProps) {
  const showDelivery = !share.active && delivery !== null;
  const showFile = !share.active && !showDelivery && viewingFile !== null && viewingFile !== undefined;

  const stageClass = share.active
    ? 'stage-sharing'
    : showDelivery
      ? 'stage-delivery'
      : showFile
        ? 'stage-file'
        : 'stage-default';

  return (
    <div className={`stage ${stageClass}`}>
      {!share.active && !showDelivery && !showFile && (
        <div className="stage-default-content">{defaultContent}</div>
      )}

      {showDelivery && delivery && (
        <div className="stage-delivery-content">
          <DeliveryViewer
            delivery={delivery}
            sessionId={sessionId}
            aiSpeaking={aiSpeaking}
            onAccept={onAcceptDelivery}
            onRevise={onReviseDelivery}


          />
        </div>
      )}

      {showFile && viewingFile && (
        <div className="stage-file-content">
          <FileViewer
            relativePath={viewingFile.relativePath}
            sessionId={sessionId}
            onClose={() => onCloseFileView?.()}
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

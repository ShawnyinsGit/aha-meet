import { useCallback, useRef, useState } from 'react';

interface UseDragAndDropOptions {
  publishDroppedFiles: (files: File[]) => void;
  onFilesDropped: () => void;
}

export function useDragAndDrop({ publishDroppedFiles, onFilesDropped }: UseDragAndDropOptions) {
  const [dropActive, setDropActive] = useState(false);
  const dragCounterRef = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDropActive(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback(() => {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDropActive(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setDropActive(false);
    publishDroppedFiles(Array.from(e.dataTransfer.files));
    onFilesDropped();
  }, [publishDroppedFiles, onFilesDropped]);

  return { dropActive, onDragEnter, onDragOver, onDragLeave, onDrop };
}

declare module 'docx-preview' {
  export interface Options {
    className?: string;
    inWrapper?: boolean;
    ignoreWidth?: boolean;
    ignoreHeight?: boolean;
  }
  export function renderAsync(
    data: ArrayBuffer | Blob,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement,
    options?: Options,
  ): Promise<void>;
}

declare module 'pptx-preview' {
  interface PptxPreview {
    init(container: HTMLElement, width: number, height: number): void;
    preview(data: ArrayBuffer): Promise<void>;
  }
  const pptx: PptxPreview;
  export default pptx;
}

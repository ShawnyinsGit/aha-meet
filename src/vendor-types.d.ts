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

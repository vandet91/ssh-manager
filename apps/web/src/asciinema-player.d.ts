declare module 'asciinema-player' {
  export function create(
    src: string,
    container: HTMLElement,
    opts?: Record<string, unknown>,
  ): void
}

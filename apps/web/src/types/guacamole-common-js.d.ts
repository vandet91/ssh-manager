declare module 'guacamole-common-js' {
  namespace Guacamole {
    class WebSocketTunnel {
      constructor(tunnelURL: string)
      onerror: ((status: Status) => void) | null
    }
    class Client {
      constructor(tunnel: WebSocketTunnel)
      connect(data?: string): void
      disconnect(): void
      getDisplay(): Display
      sendKeyEvent(pressed: number, keysym: number): void
      sendMouseState(mouseState: Mouse.State): void
      onstatechange: ((state: number) => void) | null
      onerror: ((status: Status) => void) | null
      readonly STATE_IDLE: number
      readonly STATE_CONNECTING: number
      readonly STATE_WAITING: number
      readonly STATE_CONNECTED: number
      readonly STATE_DISCONNECTING: number
      readonly STATE_DISCONNECTED: number
    }
    class Display {
      getElement(): HTMLDivElement
      getDefaultLayer(): object
      scale(scale: number): void
      onresize: ((width: number, height: number) => void) | null
      readonly width: number
      readonly height: number
    }
    class Keyboard {
      constructor(element: HTMLElement | Document)
      onkeydown: ((keysym: number) => void) | null
      onkeyup: ((keysym: number) => void) | null
      reset(): void
    }
    class Mouse {
      constructor(element: HTMLElement)
      onmousedown: ((mouseState: Mouse.State) => void) | null
      onmouseup: ((mouseState: Mouse.State) => void) | null
      onmousemove: ((mouseState: Mouse.State) => void) | null
    }
    namespace Mouse {
      class State {
        x: number
        y: number
        left: boolean
        middle: boolean
        right: boolean
        up: boolean
        down: boolean
      }
    }
    class Status {
      code: number
      message: string
    }
  }
  export = Guacamole
}

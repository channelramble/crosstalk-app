// noVNC (the screen viewer, MPL-2.0) ships no types: ScreenPage.tsx declares the parts it uses.
declare module "@novnc/novnc" {
  const RFB: new (target: HTMLElement, url: string, options?: { credentials?: { password?: string }; wsProtocols?: string[] }) => EventTarget;
  export default RFB;
}

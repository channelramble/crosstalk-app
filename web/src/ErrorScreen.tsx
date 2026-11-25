import { Component, type ReactNode } from "react";

/**
 * The last line of defence for the screen: if something throws while the app is being drawn (an answer of a shape no
 * screen expected), the person sees one plain sentence and a way back, rather than an empty page they can't leave.
 * Nothing is lost: chats, drafts and the sign-in are kept on the machine and the device, and Reload reads them again.
 */
export class ErrorScreen extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Crosstalk couldn't draw this screen:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-screen" role="alert">
        <div className="card" style={{ maxWidth: 420, textAlign: "center" }}>
          <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
          <p className="help">Crosstalk couldn't show this screen. Your chats are safe on your machine.</p>
          <div className="row" style={{ gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              className="btn"
              onClick={() => {
                location.hash = "#/";
                location.reload();
              }}
            >
              Go to Home
            </button>
            <button className="btn primary" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

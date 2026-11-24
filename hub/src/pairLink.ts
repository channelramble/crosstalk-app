// `crosstalk-hub pair` at a terminal: besides the code, a link that carries it, drawn as a QR code to scan with the
// phone's camera. Opening the link shows the pairing screen with the code filled in (web/src/views/Pairing.tsx).
import QRCode from "qrcode";

/**
 * The link that pairs a device: the machine's address with the code in it. Null when there's no address a phone could
 * open (none known, or this machine's own loopback one).
 */
export function pairLink(address: string | null | undefined, code: string): string | null {
  const raw = (address ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (/^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0$)/.test(url.hostname)) return null;
  return `${raw}/#pair=${encodeURIComponent(code)}`;
}

/** What the terminal shows under the code: the QR (dark on white whatever the terminal's colours), and the address to type instead. */
export async function pairScreen(link: string): Promise<string> {
  const qr = await QRCode.toString(link, { type: "terminal", small: true, errorCorrectionLevel: "M" });
  const address = link.replace(/\/#pair=.*$/, "");
  return ["", "Scan this with your phone's camera to pair it:", "", qr.replace(/\n+$/, ""), "", `Or open ${address} on the phone and type the code.`].join("\n");
}

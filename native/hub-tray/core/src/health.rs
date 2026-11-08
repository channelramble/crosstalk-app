//! The hub's GET /api/health on 127.0.0.1, over a plain socket: the hub only listens there, and this way the app
//! needs no HTTP or TLS libraries.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Health {
    /// It answered as Crosstalk.
    Up { version: String },
    /// Something answers on the port, but not as Crosstalk.
    Other { detail: String },
    Down { reason: String },
}

impl Health {
    pub fn up(&self) -> bool {
        matches!(self, Health::Up { .. })
    }

    pub fn version(&self) -> Option<&str> {
        match self {
            Health::Up { version } => Some(version),
            _ => None,
        }
    }
}

pub fn check(port: u16) -> Health {
    check_at(SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(1), Duration::from_secs(2))
}

pub fn check_at(addr: SocketAddr, connect: Duration, read: Duration) -> Health {
    let port = addr.port();
    match get(addr, "/api/health", connect, read) {
        Err(Failure::Refused) => Health::Down { reason: format!("Nothing answers on port {port}.") },
        Err(Failure::Timeout) => Health::Down { reason: format!("Port {port} didn't answer in time.") },
        Err(Failure::Other(e)) => Health::Down { reason: format!("Port {port}: {e}") },
        Ok((200, body)) => {
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            if v.get("name").and_then(|n| n.as_str()) == Some("crosstalk") && v.get("ok").and_then(|o| o.as_bool()) == Some(true) {
                Health::Up { version: v.get("version").and_then(|n| n.as_str()).unwrap_or("").to_string() }
            } else {
                Health::Other { detail: format!("Port {port} answers, but not as Crosstalk.") }
            }
        }
        Ok((code, _)) => Health::Other { detail: format!("Port {port} answers with HTTP {code}, not as Crosstalk.") },
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    Refused,
    Timeout,
    Other(String),
}

/// One HTTP/1.1 GET with `Connection: close`: the status code and body.
pub fn get(addr: SocketAddr, path: &str, connect: Duration, read: Duration) -> Result<(u16, Vec<u8>), Failure> {
    let io = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::ConnectionRefused => Failure::Refused,
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => Failure::Timeout,
        _ => Failure::Other(e.to_string()),
    };
    let mut s = TcpStream::connect_timeout(&addr, connect).map_err(io)?;
    s.set_read_timeout(Some(read)).map_err(io)?;
    s.set_write_timeout(Some(read)).map_err(io)?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nUser-Agent: crosstalk-hub-app\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).map_err(io)?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 1 << 20 {
                    return Err(Failure::Other("the answer was too long".into()));
                }
                if let Some(done) = complete(&buf) {
                    return done.map_err(Failure::Other);
                }
            }
            Err(e) => return Err(io(e)),
        }
    }
    parse(&buf).map_err(Failure::Other)
}

/// The response, once all of it has arrived (by Content-Length or the chunked ending); None while more is coming.
fn complete(buf: &[u8]) -> Option<Result<(u16, Vec<u8>), String>> {
    let end = find(buf, b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
    let body = &buf[end + 4..];
    if let Some(len) = header(&head, "content-length").and_then(|v| v.parse::<usize>().ok()) {
        return (body.len() >= len).then(|| parse(buf));
    }
    if header(&head, "transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        // Done once the chunks add up to the last, empty one.
        return parse(buf).ok().map(Ok);
    }
    None
}

pub fn parse(buf: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let end = find(buf, b"\r\n\r\n").ok_or("the answer had no end of headers")?;
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let status = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse::<u16>().ok()).ok_or("the answer wasn't HTTP")?;
    let lower = head.to_ascii_lowercase();
    let mut body = buf[end + 4..].to_vec();
    if header(&lower, "transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        body = unchunk(&body)?;
    } else if let Some(len) = header(&lower, "content-length").and_then(|v| v.parse::<usize>().ok()) {
        body.truncate(len);
    }
    Ok((status, body))
}

fn header<'a>(lower_head: &'a str, name: &str) -> Option<&'a str> {
    lower_head.lines().skip(1).find_map(|l| l.split_once(':').filter(|(k, _)| k.trim() == name).map(|(_, v)| v.trim()))
}

fn unchunk(mut b: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = find(b, b"\r\n").ok_or("a chunk was cut short")?;
        let size = std::str::from_utf8(&b[..line_end]).ok().and_then(|s| usize::from_str_radix(s.split(';').next().unwrap_or("").trim(), 16).ok()).ok_or("a chunk size wasn't a number")?;
        b = &b[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if b.len() < size {
            return Err("a chunk was cut short".into());
        }
        out.extend_from_slice(&b[..size]);
        b = b.get(size + 2..).unwrap_or_default();
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// A one-request server on a port the system picks, answering `reply` as is.
    fn serve(reply: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut req = [0u8; 1024];
                let _ = s.read(&mut req);
                let _ = s.write_all(reply.as_bytes());
            }
        });
        port
    }

    #[test]
    fn a_crosstalk_hub() {
        let port = serve("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 50\r\n\r\n{\"ok\":true,\"version\":\"0.4.1\",\"name\":\"crosstalk\"}  ");
        assert_eq!(check(port), Health::Up { version: "0.4.1".into() });
    }

    #[test]
    fn a_chunked_answer() {
        let port = serve("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n{\"ok\":true,\"name\r\n1e\r\n\":\"crosstalk\",\"version\":\"0.5\"}\r\n0\r\n\r\n");
        assert_eq!(check(port), Health::Up { version: "0.5".into() });
    }

    #[test]
    fn something_else_on_the_port() {
        let port = serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
        assert!(matches!(check(port), Health::Other { .. }));
        let port = serve("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        assert_eq!(check(port), Health::Other { detail: format!("Port {port} answers with HTTP 404, not as Crosstalk.") });
    }

    #[test]
    fn nothing_on_the_port() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert_eq!(check(port), Health::Down { reason: format!("Nothing answers on port {port}.") });
    }

    #[test]
    fn a_port_that_never_answers() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let h = check_at(addr, Duration::from_millis(500), Duration::from_millis(200));
        assert_eq!(h, Health::Down { reason: format!("Port {} didn't answer in time.", addr.port()) });
        drop(l);
    }
}
